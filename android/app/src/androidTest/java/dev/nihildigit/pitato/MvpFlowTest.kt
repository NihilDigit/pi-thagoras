package dev.nihildigit.pitato

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import org.hamcrest.Matchers.containsString
import java.net.HttpURLConnection
import java.net.URL
import android.graphics.Bitmap
import java.io.File
import androidx.lifecycle.ViewModelProvider
import org.junit.Rule
import org.junit.Test

class MvpFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun pairCreateAndCancelNativeApproval() {
        val uri = checkNotNull(InstrumentationRegistry.getArguments().getString("pairUri"))
        compose.onNodeWithText("添加电脑").performClick()
        compose.onNodeWithText("配对链接").performTextInput(uri)
        compose.onNodeWithText("中继地址").performTextReplacement("ws://127.0.0.1:3017")
        compose.onNodeWithText("配对", useUnmergedTree = true).performClick()
        compose.waitUntil(30000) { compose.onAllNodesWithText("Synthetic project").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Synthetic project").performClick()
        compose.onNodeWithText("新建独立聊天").performClick()
        compose.waitUntil(30000) { compose.onAllNodesWithText("发消息给电脑…").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("发消息给电脑…").performTextInput("/mvp-smoke")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(15000) { compose.onAllNodesWithText("Synthetic approval").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("取消").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("Synthetic approval").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("发消息给电脑…").performTextInput("Only the synthetic stream")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.waitUntil(10000) {
            runCatching { onView(withText(containsString("SMOKE_STREAMED"))).check(matches(isDisplayed())); true }.getOrDefault(false)
        }
        compose.onNodeWithContentDescription("预览文件").performClick()
        compose.onNodeWithText("项目内路径").performTextInput("README.md")
        compose.onNodeWithText("打开").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithText("README.md").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithContentDescription("预览文件").performClick()
        compose.onNodeWithText("项目内路径").performTextInput("pixel.png")
        compose.onNodeWithText("打开").performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithContentDescription("pixel.png").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("新建独立聊天").assertIsDisplayed()
        compose.onAllNodesWithText("未命名聊天")[0].performClick()
        compose.waitUntil(10000) {
            runCatching { onView(withText(containsString("SMOKE_STREAMED"))).check(matches(isDisplayed())); true }.getOrDefault(false)
        }
        val drop = URL("http://127.0.0.1:4319/drop-relay").openConnection() as HttpURLConnection
        drop.requestMethod = "POST"
        check(drop.responseCode == 200)
        drop.disconnect()
        try {
            compose.waitUntil(45000) {
                compose.onAllNodesWithText("Synthetic PC · 已连接").fetchSemanticsNodes().isNotEmpty() &&
                    compose.onAllNodesWithText("发消息给电脑…").fetchSemanticsNodes().isNotEmpty()
            }
        } catch (error: Throwable) {
            throw AssertionError(compose.onRoot(useUnmergedTree = true).printToString(), error)
        }
        compose.onNodeWithText("发消息给电脑…").performTextInput("After reconnect")
        compose.onNodeWithContentDescription("发送").performClick()
        val model = ViewModelProvider(compose.activity)[PitatoModel::class.java]
        compose.waitUntil(10000) { model.state.value.messages.count { it.role == "assistant" && it.text.contains("SMOKE_STREAMED") } == 2 }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.waitForIdle()
        val image = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.getExternalFilesDir(null), "mvp-chat.png").outputStream().use {
            image.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
