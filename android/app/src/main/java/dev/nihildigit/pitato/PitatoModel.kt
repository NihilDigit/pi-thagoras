package dev.nihildigit.pitato

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class ChatMessage(val id: String, val role: String, val text: String)
data class UiState(
    val computers: List<Computer> = emptyList(), val computer: Computer? = null,
    val connected: Boolean = false, val busy: Boolean = false, val error: String? = null,
    val projects: List<JSONObject> = emptyList(), val project: JSONObject? = null,
    val histories: List<JSONObject> = emptyList(), val viewing: Boolean = false,
    val messages: List<ChatMessage> = emptyList(), val streaming: Boolean = false,
    val approvals: List<JSONObject> = emptyList(), val preview: JSONObject? = null,
)

class PitatoModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("computers", 0)
    private val mutable = MutableStateFlow(UiState(computers = runCatching {
        JSONArray(preferences.getString("list", "[]")).objects().map(Computer::fromJson)
    }.getOrDefault(emptyList())))
    val state = mutable.asStateFlow()
    private val relay = RelayConnection(Identity(application)) { reason -> viewModelScope.launch { lost(reason) } }
    private var generation = ""
    private var connection: JSONObject? = null
    private var binding: JSONObject? = null
    private var cursor: JSONObject? = null
    private var polling: Job? = null
    private var reconnect: Job? = null
    private var createOperation: String? = null
    private var sendOperation: Pair<String, String>? = null
    private var selectedHistory: String? = null

    fun pair(link: String, relayUrl: String) = work {
        val uri = Uri.parse(link.trim())
        require(uri.scheme == "remotepi" && uri.host == "pair") { "请粘贴电脑端生成的配对链接" }
        val key = encode64(decode64(requireNotNull(uri.getQueryParameter("epk"))))
        require(decode64(key).size == 32)
        val target = Computer(key, uri.getQueryParameter("n") ?: "我的电脑", relayUrl.trim(), uri.getQueryParameter("rm") ?: "pitato")
        connectNow(target, requireNotNull(uri.getQueryParameter("t")))
        val computers = (mutable.value.computers.filterNot { it.key == key } + target)
        check(preferences.edit().putString("list", JSONArray(computers.map { it.toJson() }).toString()).commit())
        mutable.update { it.copy(computers = computers) }
    }

    fun connect(target: Computer) = work { connectNow(target) }

    private suspend fun connectNow(target: Computer, token: String? = null) {
        polling?.cancel(); reconnect?.cancel()
        connection = null; binding = null; cursor = null; selectedHistory = null; createOperation = null; sendOperation = null
        mutable.update { it.copy(computer = target, connected = false, viewing = false, messages = emptyList(), approvals = emptyList()) }
        val description = relay.connect(target, token)
        applyDescription(description)
    }

    private fun applyDescription(description: JSONObject) {
        generation = description.getString("generation")
        mutable.update { it.copy(connected = true, error = null, projects = description.getJSONArray("projects").objects(), project = null, histories = emptyList()) }
    }

    fun chooseProject(project: JSONObject) = work {
        leaveSession()
        mutable.update { it.copy(project = project, histories = emptyList(), viewing = false, messages = emptyList()) }
        loadHistories()
    }

    fun refresh() = work { loadHistories() }
    private suspend fun loadHistories() {
        val project = mutable.value.project ?: return
        val list = relay.request(json("action" to "histories", "projectId" to project.getString("id"))) as JSONArray
        mutable.update { it.copy(histories = list.objects().sortedByDescending { h -> h.optString("modified") }) }
    }

    fun create() = work {
        val project = checkNotNull(mutable.value.project)
        createOperation = createOperation ?: UUID.randomUUID().toString()
        val result = relay.request(json("action" to "create", "projectId" to project.getString("id"), "generation" to generation, "operationId" to createOperation)) as JSONObject
        attach(result)
        createOperation = null
    }

    fun select(history: JSONObject) = work {
        val project = checkNotNull(mutable.value.project)
        val result = relay.request(json("action" to "select", "projectId" to project.getString("id"), "historyId" to history.getString("id"), "generation" to generation)) as JSONObject
        attach(result)
    }

    private suspend fun attach(result: JSONObject) {
        check(result.optString("status") == "running" && result.has("lease")) { "会话状态需要在电脑端检查，未启动重复进程" }
        polling?.cancel()
        binding = result.getJSONObject("lease")
        selectedHistory = binding?.getString("historyId")
        connection = relay.request(json("action" to "connect", "binding" to binding)) as JSONObject
        cursor = null
        mutable.update { it.copy(viewing = true, approvals = emptyList(), error = null) }
        snapshot()
        poll()
    }

    private suspend fun snapshot() {
        val result = relay.request(json("action" to "snapshot", "connection" to connection)) as JSONObject
        cursor = result.optJSONObject("cursor")
        val messages = result.optJSONArray("messages")?.objects().orEmpty().mapIndexed { i, message ->
            ChatMessage("snapshot-$i", message.optString("role"), messageText(message))
        }.filter { it.text.isNotBlank() }
        mutable.update { it.copy(messages = messages, streaming = result.optJSONObject("state")?.optBoolean("isStreaming") ?: false) }
    }

    private fun poll() {
        polling = viewModelScope.launch {
            try {
                while (true) {
                    val command = json("action" to "poll", "connection" to connection)
                    cursor?.let { command.put("cursor", it) }
                    val result = relay.request(command) as JSONObject
                    cursor = result.getJSONObject("cursor")
                    if (result.has("gap")) snapshot()
                    else result.getJSONArray("events").objects().forEach { event(it.getJSONObject("payload")) }
                    mutable.update { it.copy(approvals = result.getJSONArray("approvals").objects()) }
                    if (!result.optBoolean("hasMore")) delay(700)
                }
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                lost(error.message ?: "连接已断开")
            }
        }
    }

    private fun event(event: JSONObject) {
        when (event.optString("type")) {
            "response" -> if (!event.optBoolean("success")) mutable.update { it.copy(error = event.optString("error", "消息未被助手接受")) }
            "agent_start" -> mutable.update { it.copy(streaming = true) }
            "agent_end" -> mutable.update { it.copy(streaming = false) }
            "message_update" -> {
                val update = event.optJSONObject("assistantMessageEvent")
                if (update?.optString("type") == "text_delta") {
                    val delta = update.optString("delta")
                    mutable.update { state ->
                        val messages = state.messages.toMutableList()
                        val last = messages.lastOrNull()
                        if (last?.id == "stream") messages[messages.lastIndex] = last.copy(text = last.text + delta)
                        else messages += ChatMessage("stream", "assistant", delta)
                        state.copy(messages = messages)
                    }
                }
            }
            "message_end" -> {
                val message = event.optJSONObject("message") ?: return
                val role = message.optString("role")
                val text = messageText(message)
                if (text.isBlank()) return
                mutable.update { state ->
                    val messages = state.messages.toMutableList()
                    if (messages.lastOrNull()?.id == "stream") messages.removeAt(messages.lastIndex)
                    messages += ChatMessage(UUID.randomUUID().toString(), role, text)
                    state.copy(messages = messages)
                }
            }
            "host_event_oversize" -> viewModelScope.launch { snapshot() }
            "host_runtime_ended" -> { connection = null; mutable.update { it.copy(viewing = false, streaming = false, approvals = emptyList(), error = "会话已结束") } }
        }
    }

    fun send(text: String, accepted: () -> Unit) = work {
        val operation = sendOperation?.takeIf { it.first == text } ?: (text to UUID.randomUUID().toString())
        sendOperation = operation
        relay.request(json("action" to "prompt", "connection" to connection, "text" to text, "operationId" to operation.second))
        sendOperation = null
        accepted()
    }
    fun abort() = work { relay.request(json("action" to "abort", "connection" to connection)) }
    fun stop() = work {
        relay.request(json("action" to "stop", "connection" to connection))
        polling?.cancel(); connection = null
        mutable.update { it.copy(viewing = false, streaming = false, approvals = emptyList()) }
        loadHistories()
    }
    fun respond(request: JSONObject, field: String, value: Any) = work {
        relay.request(json("action" to "respond", "connection" to connection,
            "response" to json("type" to "extension_ui_response", "id" to request.getString("id"), field to value)))
        mutable.update { it.copy(approvals = it.approvals.filterNot { a -> a.getJSONObject("request").getString("id") == request.getString("id") }) }
    }
    fun preview(path: String) = work {
        val preview = relay.request(json("action" to "preview", "connection" to connection, "path" to path)) as JSONObject
        mutable.update { it.copy(preview = preview) }
    }
    fun dismissPreview() { mutable.update { it.copy(preview = null) } }
    fun clearError() { mutable.update { it.copy(error = null) } }
    fun back() = work {
        if (mutable.value.viewing) { leaveSession(); mutable.update { it.copy(viewing = false, messages = emptyList()) }; loadHistories() }
        else if (mutable.value.project != null) mutable.update { it.copy(project = null, histories = emptyList()) }
        else { relay.close(); mutable.update { it.copy(computer = null, connected = false, projects = emptyList()) } }
    }

    private suspend fun leaveSession() {
        polling?.cancel()
        val old = connection
        connection = null; binding = null; cursor = null; selectedHistory = null
        mutable.update { it.copy(approvals = emptyList()) }
        if (old != null) runCatching { relay.request(json("action" to "disconnect", "connection" to old)) }
    }

    private fun lost(reason: String) {
        polling?.cancel()
        connection = null; cursor = null
        mutable.update { it.copy(connected = false, approvals = emptyList(), streaming = false, error = reason) }
        if (reconnect?.isActive == true) return
        val target = mutable.value.computer ?: return
        val history = selectedHistory
        val project = mutable.value.project
        reconnect = viewModelScope.launch {
            var attempt = 0
            while (true) {
                delay(minOf(30000L, 1000L shl minOf(attempt++, 5)))
                try {
                    val description = relay.connect(target)
                    val oldGeneration = generation
                    applyDescription(description)
                    mutable.update { it.copy(project = project, viewing = false) }
                    if (history != null && project != null) {
                        if (generation == oldGeneration && binding != null) attach(json("status" to "running", "lease" to binding))
                        else loadHistories()
                    }
                    return@launch
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (BuildConfig.DEBUG) android.util.Log.w("pitato", "Reconnect failed: ${error.message}")
                    mutable.update { it.copy(error = "等待电脑重新上线…") }
                }
            }
        }
    }

    private fun work(action: suspend () -> Unit) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null) }
            try { action() }
            catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                mutable.update { it.copy(error = error.message ?: "操作未完成") }
            }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }

    override fun onCleared() { relay.close() }
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
fun messageText(message: JSONObject): String {
    val content = message.opt("content")
    return when (content) {
        is String -> content
        is JSONArray -> content.objects().filter { it.optString("type") == "text" }.joinToString("\n") { it.optString("text") }
        else -> ""
    }
}
