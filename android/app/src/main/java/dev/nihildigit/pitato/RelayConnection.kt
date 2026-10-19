package dev.nihildigit.pitato

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

fun json(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().apply {
    fields.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}

data class Computer(val key: String, val name: String, val relay: String, val room: String = "pitato") {
    fun toJson(): JSONObject = json("key" to key, "name" to name, "relay" to relay, "room" to room)
    companion object {
        fun fromJson(value: JSONObject) = Computer(value.getString("key"), value.getString("name"), value.getString("relay"), value.optString("room", "pitato"))
    }
}

/** Remote Pi's Ed25519 hello/auth and base64 JSON envelope, with correlated host replies. */
class RelayConnection(private val identity: Identity, private val onLost: (String) -> Unit) {
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    @Volatile private var socket: WebSocket? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private var computer: Computer? = null
    private var challenge = CompletableDeferred<String>()

    suspend fun connect(target: Computer, token: String? = null): JSONObject {
        close()
        computer = target
        challenge = CompletableDeferred()
        require(target.relay.startsWith("wss://") || (BuildConfig.DEBUG && target.relay.startsWith("ws://"))) { "Relay must use wss://" }
        socket = client.newWebSocket(Request.Builder().url(target.relay).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (socket !== webSocket) return
                webSocket.send(json("type" to "hello", "pubkey" to identity.publicKey, "room_id" to "main").toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (socket !== webSocket || text.length > 4_000_000) return
                try {
                    val outer = JSONObject(text)
                    when {
                        outer.optString("type") == "challenge" -> challenge.complete(outer.getString("nonce"))
                        outer.has("peer") && outer.has("ct") -> {
                            if (!decode64(outer.getString("peer")).contentEquals(decode64(target.key))) return
                            val message = JSONObject(decode64(outer.getString("ct")).toString(Charsets.UTF_8))
                            pending.remove(message.optString("in_reply_to"))?.complete(message)
                        }
                        outer.optString("type") == "error" -> fail(webSocket, "Relay rejected the connection")
                    }
                } catch (_: Exception) { fail(webSocket, "Invalid relay response") }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = fail(webSocket, "电脑连接已断开")
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = fail(webSocket, "电脑连接已关闭")
        })
        val nonce = withTimeout(10000) { challenge.await() }
        check(socket?.send(json("type" to "auth", "sig" to identity.sign(decode64(nonce))).toString()) == true)
        if (token != null) {
            val reply = exchange(json("type" to "pair_request", "token" to token, "device_name" to "pitato Android"))
            check(reply.optString("type") == "pair_ok") { "配对链接已失效，请在电脑端重新生成" }
        }
        val hello = exchange(json("type" to "host_hello"), timeoutMs = 5000)
        check(hello.optBoolean("ok")) { "请在电脑端更新并启动 pitato host" }
        return hello.getJSONObject("data")
    }

    suspend fun request(command: JSONObject): Any? {
        val reply = exchange(json("type" to "host_request", "command" to command))
        check(reply.optBoolean("ok")) { reply.optString("error", "请求未完成") }
        return reply.opt("data")
    }

    private suspend fun exchange(message: JSONObject, timeoutMs: Long = 30000): JSONObject {
        val id = UUID.randomUUID().toString()
        check(pending.size < 32) { "Too many pending requests" }
        val result = CompletableDeferred<JSONObject>()
        pending[id] = result
        message.put("id", id)
        val target = checkNotNull(computer)
        try {
            val frame = json("peer" to target.key, "room" to target.room, "ct" to encode64(message.toString().toByteArray()))
            check(socket?.send(frame.toString()) == true) { "电脑未连接" }
            return withTimeout(timeoutMs) { result.await() }
        } finally { pending.remove(id) }
    }

    fun close() {
        val old = socket
        socket = null
        old?.close(1000, "Leaving")
        pending.values.forEach { it.completeExceptionally(IOException("Connection closed")) }
        pending.clear()
    }

    private fun fail(webSocket: WebSocket, reason: String) {
        if (socket !== webSocket) return
        challenge.completeExceptionally(IOException(reason))
        close()
        onLost(reason)
    }
}
