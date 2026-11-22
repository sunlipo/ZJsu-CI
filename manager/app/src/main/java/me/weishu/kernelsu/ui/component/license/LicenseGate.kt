package me.weishu.kernelsu.ui.component.license

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch
import me.weishu.kernelsu.data.license.LicenseClient
import me.weishu.kernelsu.data.license.LicenseConfig
import me.weishu.kernelsu.data.license.LicenseResult
import me.weishu.kernelsu.data.license.LicenseStore

private sealed interface GateState {
    data object Checking : GateState
    data object Free : GateState
    data class Blocked(val message: String) : GateState
}

/**
 * 卡密闸门：没有有效授权时铺满整个界面，挡住后面的所有页面。
 *
 * 构建时没注入 LICENSE_SERVER 就直接放行（自用包不受影响）。
 * 首次启动校验本地令牌；服务端拒绝就清空授权要求重新激活，断网则按本地到期时间宽限。
 */
@Composable
fun LicenseGate(modifier: Modifier = Modifier) {
    if (!LicenseConfig.enabled) return

    var state by remember { mutableStateOf<GateState>(GateState.Checking) }
    var input by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        if (!LicenseStore.hasActivation) {
            state = GateState.Blocked("请输入卡密激活")
            return@LaunchedEffect
        }
        when (val result = LicenseClient.verify(LicenseStore.card, LicenseStore.deviceId, LicenseStore.token)) {
            is LicenseResult.Ok -> {
                LicenseStore.updateExpiry(result.expiresAt)
                state = GateState.Free
            }
            is LicenseResult.Denied -> {
                if (LicenseStore.cacheValid()) {
                    state = GateState.Free
                } else {
                    LicenseStore.clear()
                    state = GateState.Blocked(result.message)
                }
            }
            LicenseResult.Offline -> {
                state = if (LicenseStore.cacheValid()) {
                    GateState.Free
                } else {
                    GateState.Blocked("网络异常，无法校验授权")
                }
            }
        }
    }

    when (state) {
        GateState.Free -> return
        GateState.Checking -> Unit
        is GateState.Blocked -> Unit
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.Shield,
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = "钻酱SU",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = "本应用需要卡密授权",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(26.dp))

            if (state is GateState.Checking) {
                CircularProgressIndicator(modifier = Modifier.size(26.dp))
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "正在校验授权…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                OutlinedTextField(
                    value = input,
                    onValueChange = {
                        input = it.uppercase().replace(" ", "")
                        message = ""
                    },
                    modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                    label = { Text("卡密") },
                    placeholder = { Text("ZJ-XXXX-XXXX-XXXX") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        if (busy) return@Button
                        val card = input.trim()
                        if (card.isEmpty()) {
                            message = "请先输入卡密"
                            return@Button
                        }
                        busy = true
                        scope.launch {
                            when (val result = LicenseClient.activate(card, LicenseStore.deviceId)) {
                                is LicenseResult.Ok -> {
                                    val token = result.token.ifEmpty { LicenseStore.token }
                                    LicenseStore.save(card, token, result.expiresAt, result.plan)
                                    state = GateState.Free
                                }
                                is LicenseResult.Denied -> message = result.message
                                LicenseResult.Offline -> message = "网络异常，请检查网络后重试"
                            }
                            busy = false
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                ) {
                    Text(if (busy) "激活中…" else "激活")
                }

                val errorText = (state as? GateState.Blocked)?.message.orEmpty()
                val showText = message.ifBlank { errorText }
                if (showText.isNotBlank()) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = showText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }

                if (LicenseStore.hasActivation) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = "当前卡密：${LicenseStore.card}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (LicenseStore.expiresAt > 0) {
                        Text(
                            text = "到期时间：${formatTime(LicenseStore.expiresAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Spacer(Modifier.height(26.dp))
            Text(
                text = "设备标识：${LicenseStore.deviceId}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                textAlign = TextAlign.Center,
            )
            Text(
                text = "换机请联系作者解绑，卡密一机一码",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun formatTime(epochMs: Long): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
    return formatter.format(Date(epochMs))
}
