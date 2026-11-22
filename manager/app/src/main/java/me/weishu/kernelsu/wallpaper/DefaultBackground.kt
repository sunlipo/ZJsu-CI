package me.weishu.kernelsu.wallpaper

import android.content.Context
import android.net.Uri
import java.io.File
import me.weishu.kernelsu.R

/**
 * 把内置的「为人民服务」壁纸装成管理器默认背景。
 *
 * 只在首次启动时写入一次；写入后由正常的壁纸配置接管，因此不会覆盖用户之后的修改。
 * 壁纸整体接近纯黑，派生亮度取低值，主题据此切到浅色文字，保证深色背景上的可读性。
 */
object DefaultBackground {
    private const val PREFS = "zjsu_defaults"
    private const val KEY_APPLIED = "background_applied_v1"
    private const val FILE_NAME = "zjsu_bg.jpg"

    /** 接近纯黑的背景：派生亮度低于阈值，亮色主题会自动改用深色中性色（浅色文字）。 */
    private const val DERIVED_LUMINANCE = 0.02f

    fun applyIfNeeded(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_APPLIED, false)) return

        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists() || file.length() == 0L) {
            context.resources.openRawResource(R.drawable.zjsu_bg).use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
            }
        }

        WallpaperConfig.updateUri(Uri.fromFile(file).toString())
        WallpaperConfig.updateEnabled(true)
        WallpaperConfig.updateMultiBackgroundEnabled(false)
        WallpaperConfig.updateOpacity(0.82f)
        WallpaperConfig.updateDim(0.45f)
        WallpaperConfig.updateDualDimEnabled(false)
        WallpaperConfig.updateDayDim(0.4f)
        WallpaperConfig.updateNightDim(0.55f)
        WallpaperConfig.updateUseWallpaperColor(false)
        // 文字颜色适配的关键：亮度决定浅/深文字极性。
        WallpaperConfig.updateDerivedLuminance(DERIVED_LUMINANCE)
        WallpaperConfig.updateDerivedSeed(0x1B1B1B)
        WallpaperConfig.save(context, durable = true)
        prefs.edit().putBoolean(KEY_APPLIED, true).apply()
    }
}
