package dev.nihildigit.pitato

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.LinkResolver
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.image.glide.GlideImagesPlugin
import io.noties.markwon.linkify.LinkifyPlugin
import org.json.JSONObject

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
class MainActivity : ComponentActivity() {
    private val model by viewModels<PitatoModel>()
    private var initialLink by mutableStateOf("")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        initialLink = intent.dataString.orEmpty()
        setContent {
            MaterialExpressiveTheme(colorScheme = lightColorScheme(
                primary = Color(0xFF3D622E), onPrimary = Color.White,
                primaryContainer = Color(0xFFD8EDBC), onPrimaryContainer = Color(0xFF142C0A),
                surface = Color(0xFFFAF9F1), surfaceContainer = Color(0xFFF0F0E6),
                surfaceContainerHigh = Color(0xFFE8EADD),
            )) {
                val state by model.state.collectAsStateWithLifecycle()
                PitatoApp(state, model, initialLink)
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); initialLink = intent.dataString.orEmpty() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PitatoApp(state: UiState, model: PitatoModel, initialLink: String) {
    var pairing by rememberSaveable { mutableStateOf(false) }
    var filePicker by rememberSaveable { mutableStateOf(false) }
    var link by rememberSaveable(initialLink) { mutableStateOf(initialLink) }
    var relay by rememberSaveable { mutableStateOf("wss://pi-relay.nihildigit.dev") }
    LaunchedEffect(initialLink) { if (initialLink.isNotBlank()) pairing = true }
    BackHandler(state.computer != null) { model.back() }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column {
                    Text(if (state.computer == null) "pitato" else state.project?.optString("name") ?: state.computer.name)
                    if (state.computer != null) Text(
                        state.computer.name + if (state.connected) " · 已连接" else " · 等待重连",
                        style = MaterialTheme.typography.labelMedium,
                    )
                } },
                navigationIcon = {
                    if (state.computer != null) IconButton(onClick = { model.back() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "返回") }
                },
                actions = {
                    if (state.viewing) IconButton(onClick = { filePicker = true }) { Icon(Icons.Rounded.FolderOpen, "预览文件") }
                    if (state.project != null && !state.viewing) IconButton(onClick = { model.refresh() }) { Icon(Icons.Rounded.Refresh, "刷新历史") }
                    if (state.computer == null) IconButton(onClick = { pairing = true }) { Icon(Icons.Rounded.Add, "添加电脑") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.error != null) Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Text(state.error, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
            }
            when {
                state.computer == null -> ComputerScreen(state, { model.connect(it) }, { pairing = true })
                !state.connected -> Box(Modifier.weight(1f).fillMaxWidth(), Alignment.Center) { Text("正在连接电脑…") }
                state.viewing -> ChatScreen(state, model, Modifier.weight(1f))
                state.project == null -> LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item { Intro("从项目开始", "选择这台电脑上开放的项目。聊天历史按电脑与项目独立保存。") }
                    items(state.projects, key = { it.getString("id") }) { project ->
                        Card(onClick = { model.chooseProject(project) }, enabled = !state.busy) {
                            ListItem(headlineContent = { Text(project.getString("name")) }, leadingContent = { Icon(Icons.Rounded.Folder, null) })
                        }
                    }
                }
                else -> LazyColumn(contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item {
                        Intro("继续思路，或重新开始", "选择历史会话会续接原来的聊天。正在运行的会话会直接连接。")
                        Button(onClick = { model.create() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).height(56.dp)) {
                            Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("新建独立聊天")
                        }
                    }
                    if (state.histories.isEmpty()) item { Text("这里还没有聊天，开始第一段对话吧。", Modifier.padding(16.dp)) }
                    items(state.histories, key = { it.getString("id") }) { history ->
                        Card(onClick = { model.select(history) }, enabled = !state.busy) {
                            ListItem(headlineContent = { Text(history.optString("name").ifBlank { "未命名聊天" }) },
                                supportingContent = { Text(history.optString("modified").replace('T', ' ').take(16)) },
                                leadingContent = { Icon(Icons.Rounded.ChatBubbleOutline, null) })
                        }
                    }
                }
            }
        }
    }
    if (pairing) AlertDialog(onDismissRequest = { pairing = false }, title = { Text("连接你的电脑") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("在电脑上打开 pitato，生成配对链接并粘贴到这里。")
            OutlinedTextField(link, { link = it }, label = { Text("配对链接") }, maxLines = 4)
            OutlinedTextField(relay, { relay = it }, label = { Text("中继地址") }, singleLine = true)
        } }, confirmButton = { Button(onClick = { model.pair(link, relay); pairing = false }, enabled = link.isNotBlank() && !state.busy) { Text("配对") } },
        dismissButton = { TextButton(onClick = { pairing = false }) { Text("取消") } })
    if (filePicker) {
        var path by rememberSaveable { mutableStateOf("") }
        AlertDialog(onDismissRequest = { filePicker = false }, title = { Text("预览项目文件") }, text = {
            OutlinedTextField(path, { path = it }, label = { Text("项目内路径") }, placeholder = { Text("README.md") })
        }, confirmButton = { Button(onClick = { model.preview(path); filePicker = false }, enabled = path.isNotBlank()) { Text("打开") } },
            dismissButton = { TextButton(onClick = { filePicker = false }) { Text("取消") } })
    }
    state.preview?.let { preview ->
        AlertDialog(onDismissRequest = model::dismissPreview, title = { Text(preview.optString("path")) }, text = {
            if (preview.optString("mime").startsWith("image/")) {
                val bitmap = remember(preview) {
                    val bytes = decode64(preview.getString("base64"))
                    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                    options.inSampleSize = 1
                    while (options.outWidth.toLong() * options.outHeight / options.inSampleSize / options.inSampleSize > 4_000_000) options.inSampleSize *= 2
                    options.inJustDecodeBounds = false
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                }
                if (bitmap != null) Image(bitmap.asImageBitmap(), preview.optString("path"), Modifier.fillMaxWidth().heightIn(max = 480.dp))
            } else LazyColumn(Modifier.heightIn(max = 480.dp)) { item { SelectionContainer { Text(preview.optString("text"), fontFamily = FontFamily.Monospace) } } }
        }, confirmButton = { TextButton(onClick = model::dismissPreview) { Text("关闭") } })
    }
    state.approvals.firstOrNull()?.let { approval -> ApprovalDialog(approval, model) }
}

@Composable
private fun Intro(title: String, detail: String) {
    Text(title, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 16.dp, bottom = 12.dp))
    Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ComputerScreen(state: UiState, connect: (Computer) -> Unit, pair: () -> Unit) {
    LazyColumn(contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Intro("把电脑带在身边", "从手机继续项目、查看结果，并在需要时回应电脑上的请求。") }
        items(state.computers, key = { it.key }) { computer ->
            Card(onClick = { connect(computer) }, enabled = !state.busy) {
                ListItem(headlineContent = { Text(computer.name) }, supportingContent = { Text("点击连接") }, leadingContent = { Icon(Icons.Rounded.Computer, null) })
            }
        }
        item { Button(onClick = pair, Modifier.fillMaxWidth().padding(top = 20.dp).height(56.dp)) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("添加电脑") } }
    }
}

@Composable
private fun ChatScreen(state: UiState, model: PitatoModel, modifier: Modifier) {
    var draft by rememberSaveable(state.project?.optString("id")) { mutableStateOf("") }
    val list = rememberLazyListState()
    val follow = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= state.messages.lastIndex - 1 } ?: true
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text) { if (follow && state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.lastIndex) }
    Column(modifier) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.messages.isEmpty()) item { Intro("今天想做些什么？", "消息会发给这台电脑上的助手。") }
            items(state.messages, key = { it.id }) { message ->
                val isUser = message.role == "user"
                Surface(color = if (isUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                    shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(18.dp)) {
                        Text(when (message.role) { "user" -> "你"; "toolResult" -> "工具结果"; else -> "助手" }, style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.height(8.dp))
                        Markdown(message.text, model::preview)
                    }
                }
            }
        }
        if (state.streaming) Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Text(" 正在处理…", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { model.abort() }) { Text("停止生成") }
        }
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(draft, { draft = it }, Modifier.weight(1f), placeholder = { Text("发消息给电脑…") }, maxLines = 6, shape = RoundedCornerShape(28.dp))
            Spacer(Modifier.width(8.dp))
            FilledIconButton(onClick = { model.send(draft) { draft = "" } }, enabled = draft.isNotBlank() && !state.busy && state.connected, modifier = Modifier.size(56.dp)) {
                Icon(Icons.AutoMirrored.Rounded.Send, "发送")
            }
        }
    }
}

@Composable
private fun Markdown(text: String, preview: (String) -> Unit) {
    val context = LocalContext.current
    val color = MaterialTheme.colorScheme.onSurface
    val renderer = remember(context) {
        Markwon.builder(context).usePlugin(TablePlugin.create(context)).usePlugin(StrikethroughPlugin.create())
            .usePlugin(LinkifyPlugin.create()).usePlugin(GlideImagesPlugin.create(context))
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
                    builder.linkResolver(object : LinkResolver {
                        override fun resolve(view: android.view.View, link: String) {
                            val uri = Uri.parse(link)
                            if (uri.scheme == "https" || uri.scheme == "http") context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                            else if (uri.scheme == null) preview(Uri.decode(link.substringBefore('#')))
                        }
                    })
                }
            }).build()
    }
    AndroidView(factory = { TextView(it).apply { textSize = 16f; setTextIsSelectable(true); setLineSpacing(4f, 1.05f) } },
        update = { view -> view.setTextColor(android.graphics.Color.argb(255, (color.red * 255).toInt(), (color.green * 255).toInt(), (color.blue * 255).toInt())); renderer.setMarkdown(view, text) },
        modifier = Modifier.fillMaxWidth())
}

@Composable
private fun ApprovalDialog(approval: JSONObject, model: PitatoModel) {
    val request = approval.getJSONObject("request")
    val method = request.getString("method")
    var answer by rememberSaveable(request.getString("id")) { mutableStateOf(request.optString("prefill")) }
    val state by model.state.collectAsStateWithLifecycle()
    AlertDialog(onDismissRequest = { model.respond(request, "cancelled", true) },
        title = { Text(request.getString("title")) },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("${state.computer?.name} · ${state.project?.optString("name")}\n仅回应当前请求，断连或过期后失效。", style = MaterialTheme.typography.labelMedium) }
            if (request.has("message")) item { SelectionContainer { Text(request.getString("message")) } }
            if (method == "select") {
                val options = request.getJSONArray("options")
                items(options.length()) { index ->
                    val value = options.getString(index)
                    OutlinedButton(onClick = { model.respond(request, "value", value) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(value) }
                }
            }
            if (method == "input" || method == "editor") item { OutlinedTextField(answer, { answer = it }, placeholder = { Text(request.optString("placeholder")) }) }
        } },
        confirmButton = {
            if (method == "confirm") Button(onClick = { model.respond(request, "confirmed", true) }, enabled = !state.busy) { Text("确认这一次") }
            if (method == "input" || method == "editor") Button(onClick = { model.respond(request, "value", answer) }, enabled = !state.busy) { Text("提交") }
        },
        dismissButton = { TextButton(onClick = { model.respond(request, "cancelled", true) }, enabled = !state.busy) { Text("取消") } },
    )
}
