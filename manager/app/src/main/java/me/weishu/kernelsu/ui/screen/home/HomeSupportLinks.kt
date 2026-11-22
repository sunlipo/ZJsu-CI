package me.weishu.kernelsu.ui.screen.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import me.weishu.kernelsu.ui.component.material.LocalWallpaperSupportingColor
import me.weishu.kernelsu.ui.component.material.folkPressScale
import me.weishu.kernelsu.ui.theme.FolkType
import me.weishu.kernelsu.ui.util.AuthorLinks

/**
 * 首页底部唯一的入口卡片。
 *
 * 原本这里有「了解更多 FinaSU」、上游捐赠、用户自定义等多套形态，现在统一收敛成一行：
 * 点击直达作者快手。内置公告、反馈等按钮也一并走 [AuthorLinks.KUAISHOU_URL]。
 */
@Composable
internal fun SupportLinks(
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    HomeCard(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth()) {
            SupportLinkRow(
                icon = Icons.Outlined.Info,
                title = AuthorLinks.AUTHOR_LABEL,
                subtitle = "点击打开快手作者：钻酱",
                onClick = { onOpenUrl(AuthorLinks.KUAISHOU_URL) },
            )
        }
    }
}

@Composable
private fun SupportLinkRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val haptic = LocalHapticFeedback.current
    // On wallpaper the card material carries its own supporting colour, tuned against the
    // translucent fill; off it we keep the semantic greys.
    val supportingColor = LocalWallpaperSupportingColor.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .folkPressScale(interactionSource)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onClick()
                },
            )
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = icon,
            contentDescription = title,
            modifier = Modifier.size(20.dp),
            tint = supportingColor ?: MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = FolkType.Summary)
            Spacer(Modifier.height(4.dp))
            Text(
                text = subtitle,
                style = FolkType.Caption,
                color = supportingColor ?: MaterialTheme.colorScheme.outline
            )
        }
        Spacer(Modifier.width(12.dp))
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = supportingColor ?: MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
