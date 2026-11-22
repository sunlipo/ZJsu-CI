package me.weishu.kernelsu.ui.component.license

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch
import me.weishu.kernelsu.R
import me.weishu.kernelsu.data.license.LicenseClient
import me.weishu.kernelsu.data.license.LicenseConfig
import me.weishu.kernelsu.data.license.LicenseResult
import me.weishu.kernelsu.data.license.LicenseStore

private sealed interface GateState {
    data object Checking : GateState
    data object Free : GateState
    data class Blocked(val message: String) : GateState
}

private val Gold = Color(0xFFE8C46A)
private val GoldBright = Color(0xFFF5DD9B)
private val Ink = Color(0xFFECEAE4)
private val Muted = Color(0xFF8B9089)
private val Panel = Color(0xF2171A18)
private val Field = Color(0xFF101312)
private val Danger = Color(0xFFFF9F9A)
private val Ok = Color(0xFF6FD39A)

/**
 * 卡密闸门：没有有效授权时铺满整个界面，挡住后面的所有页面。
 *
 * 界面沿用后台控制台的黑金风格：深色底 + 金色描边卡片 + 金色渐变按钮。
 * 构建时没注入 LICENSE_SERVER 就直接放行（自用包不受影响）。
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

    if (state is GateState.Free) return

    val errorText = message.ifBlank { (state as? GateState.Blocked)?.message.orEmpty() }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF08090A), Color(0xFF12100B), Color(0xFF08090A))
                )
            ),
        contentAlignment = Alignment.Center,
    ) {
        // 金色氛围光
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(Gold.copy(alpha = 0.18f), Color.Transparent),
                    )
                )
        )

        Column(
            modifier = Modifier
                .padding(horizontal = 20.dp)
                .fillMaxWidth()
                .widthIn(max = 430.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(Panel)
                .border(1.dp, Gold.copy(alpha = 0.38f), RoundedCornerShape(24.dp))
                .padding(horizontal = 20.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // 顶栏：品牌
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(Gold)
                    )
                    Spacer(Modifier.width(7.dp))
                    Text("钻酱ovo", color = Gold, fontSize = 11.sp, letterSpacing = 1.2.sp)
                }
                Text("钻酱SU", color = Muted, fontSize = 11.sp, letterSpacing = 1.2.sp)
            }

            Spacer(Modifier.height(16.dp))

            // 头像
            Box(
                modifier = Modifier
                    .size(86.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .border(1.dp, Gold.copy(alpha = 0.55f), RoundedCornerShape(24.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(id = R.drawable.about_icon_anime),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(24.dp)),
                )
            }

            Spacer(Modifier.height(14.dp))

            Text(
                text = "钻酱-泪痕SU安全网络控制台",
                color = GoldBright,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.4.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(5.dp))
            Text(
                text = "一机一码 · 联网校验 · 独立守护",
                color = Muted,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(12.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                GateChip("ONLINE SYS")
                GateChip("14-BIT KEY")
                GateChip("PASS VERIFY")
            }

            Spacer(Modifier.height(16.dp))

            if (state is GateState.Checking) {
                CircularProgressIndicator(modifier = Modifier.size(26.dp), color = Gold)
                Spacer(Modifier.height(10.dp))
                Text("正在校验授权…", color = Muted, fontSize = 11.sp)
            } else {
                OutlinedTextField(
                    value = input,
                    onValueChange = {
                        input = it.uppercase().replace(" ", "")
                        message = ""
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("卡密") },
                    placeholder = { Text("ZJ-XXXX-XXXX-XXXX") },
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Ink,
                        unfocusedTextColor = Ink,
                        focusedContainerColor = Field,
                        unfocusedContainerColor = Field,
                        cursorColor = Gold,
                        focusedBorderColor = Gold,
                        unfocusedBorderColor = Gold.copy(alpha = 0.3f),
                        focusedLabelColor = Gold,
                        unfocusedLabelColor = Muted,
                        focusedPlaceholderColor = Muted.copy(alpha = 0.7f),
                        unfocusedPlaceholderColor = Muted.copy(alpha = 0.7f),
                    ),
                )

                Spacer(Modifier.height(12.dp))

                // 金色渐变按钮
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(Brush.verticalGradient(listOf(GoldBright, Gold)))
                        .clickable(enabled = !busy) {
                            if (busy) return@clickable
                            val card = input.trim()
                            if (card.isEmpty()) {
                                message = "请先输入卡密"
                                return@clickable
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
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (busy) "激活中…" else "激活并进入",
                        color = Color(0xFF191407),
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.5.sp,
                    )
                }

                if (errorText.isNotBlank()) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = errorText,
                        color = Danger,
                        fontSize = 11.sp,
                        textAlign = TextAlign.Center,
                    )
                }

                if (LicenseStore.hasActivation) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = "当前卡密：${LicenseStore.card}",
                        color = Muted,
                        fontSize = 10.sp,
                    )
                    if (LicenseStore.expiresAt > 0) {
                        Text(
                            text = "到期时间：${formatTime(LicenseStore.expiresAt)}",
                            color = Muted,
                            fontSize = 10.sp,
                        )
                    }
                }
            }

            Spacer(Modifier.height(18.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(Ok)
                )
                Spacer(Modifier.width(6.dp))
                Text("服务运行中 · 钻酱SU 1.0", color = Muted, fontSize = 9.5.sp, letterSpacing = 0.6.sp)
            }

            Spacer(Modifier.height(6.dp))
            Text(
                text = "设备标识：${LicenseStore.deviceId}",
                color = Muted.copy(alpha = 0.75f),
                fontSize = 9.sp,
                textAlign = TextAlign.Center,
            )
            Text(
                text = "换机请联系作者解绑，卡密一机一码",
                color = Muted.copy(alpha = 0.75f),
                fontSize = 9.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun GateChip(text: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .border(1.dp, Gold.copy(alpha = 0.3f), RoundedCornerShape(50))
            .padding(horizontal = 9.dp, vertical = 4.dp)
    ) {
        Text(text, color = Gold.copy(alpha = 0.85f), fontSize = 8.5.sp, letterSpacing = 0.8.sp)
    }
}

private fun formatTime(epochMs: Long): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
    return formatter.format(Date(epochMs))
}
