package me.weishu.kernelsu.data.license

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit
import java.security.MessageDigest
import me.weishu.kernelsu.ksuApp

/**
 * 本机授权状态：卡密、服务端令牌、到期时间，以及稳定的设备标识。
 *
 * 令牌只做透传，服务端每次重算 HMAC；到期时间本地留一份，断网时用它做宽限判断。
 */
object LicenseStore {
    private const val PREFS = "license"
    private const val KEY_CARD = "card"
    private const val KEY_TOKEN = "token"
    private const val KEY_EXPIRES = "expires_at"
    private const val KEY_PLAN = "plan"

    /** 设备标识：ANDROID_ID + 机型信息哈希，卸载重装不变，刷机才会变。 */
    val deviceId: String by lazy { computeDeviceId() }

    private fun prefs() = ksuApp.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val card: String
        get() = prefs().getString(KEY_CARD, "").orEmpty()

    val token: String
        get() = prefs().getString(KEY_TOKEN, "").orEmpty()

    val plan: String
        get() = prefs().getString(KEY_PLAN, "").orEmpty()

    /** 到期时间戳（毫秒）；0 表示永久。 */
    val expiresAt: Long
        get() = prefs().getLong(KEY_EXPIRES, 0L)

    val hasActivation: Boolean
        get() = card.isNotEmpty() && token.isNotEmpty()

    /** 本地缓存的授权是否仍在有效期内（用于断网宽限）。 */
    fun cacheValid(): Boolean {
        if (!hasActivation) return false
        val expiry = expiresAt
        return expiry == 0L || expiry > System.currentTimeMillis()
    }

    fun save(card: String, token: String, expiresAt: Long, plan: String) {
        prefs().edit {
            putString(KEY_CARD, card)
            putString(KEY_TOKEN, token)
            putLong(KEY_EXPIRES, expiresAt)
            putString(KEY_PLAN, plan)
        }
    }

    fun updateExpiry(expiresAt: Long) {
        prefs().edit { putLong(KEY_EXPIRES, expiresAt) }
    }

    fun clear() {
        prefs().edit { clear() }
    }

    private fun computeDeviceId(): String {
        val androidId = runCatching {
            Settings.Secure.getString(ksuApp.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull().orEmpty()
        val raw = listOf(
            androidId,
            Build.FINGERPRINT,
            Build.BRAND,
            Build.DEVICE,
            Build.MODEL,
            Build.HARDWARE,
        ).joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }
}
