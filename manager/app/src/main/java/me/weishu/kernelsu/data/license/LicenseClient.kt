package me.weishu.kernelsu.data.license

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.weishu.kernelsu.ksuApp
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** 一次授权请求的结果。 */
sealed interface LicenseResult {
    data class Ok(
        val expiresAt: Long,
        val remainingSec: Long,
        val token: String,
        val plan: String = "",
    ) : LicenseResult

    /** 服务端明确拒绝（卡不存在、已过期、绑了别的设备等），[message] 直接展示给用户。 */
    data class Denied(val message: String) : LicenseResult

    /** 网络不通或服务器异常；调用方可以用本地缓存继续放行。 */
    data object Offline : LicenseResult
}

/**
 * 卡密服务端客户端。
 *
 * 只做两件事：激活（首次绑设备）和校验（每次启动核对令牌与有效期）。
 */
object LicenseClient {
    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

    suspend fun activate(card: String, deviceId: String): LicenseResult =
        post("/api/activate", JSONObject().put("card", card).put("device", deviceId))

    suspend fun verify(card: String, deviceId: String, token: String): LicenseResult =
        post("/api/verify", JSONObject().put("card", card).put("device", deviceId).put("token", token))

    private suspend fun post(path: String, payload: JSONObject): LicenseResult = withContext(Dispatchers.IO) {
        if (!LicenseConfig.enabled) return@withContext LicenseResult.Denied("未配置授权服务器")

        val request = Request.Builder()
            .url(LicenseConfig.baseUrl + path)
            .post(payload.toString().toRequestBody(JSON_TYPE))
            .build()

        runCatching {
            ksuApp.okhttpClient.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(body) }.getOrNull()
                if (response.isSuccessful && json?.optBoolean("ok") == true) {
                    LicenseResult.Ok(
                        expiresAt = json.optLong("expiresAt", 0L),
                        remainingSec = json.optLong("remainingSec", -1L),
                        token = json.optString("token", ""),
                        plan = json.optString("plan", ""),
                    )
                } else {
                    val reason = json?.optString("error", "").orEmpty().ifBlank {
                        "服务器返回 ${response.code}"
                    }
                    LicenseResult.Denied(reason)
                }
            }
        }.getOrElse { LicenseResult.Offline }
    }
}
