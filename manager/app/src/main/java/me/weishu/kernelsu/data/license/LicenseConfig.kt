package me.weishu.kernelsu.data.license

import me.weishu.kernelsu.BuildConfig

/**
 * 卡密授权服务端地址。
 *
 * 构建时由 `-PLICENSE_SERVER=https://你的域名` 注入（GitHub Actions 里读仓库变量 LICENSE_SERVER）。
 * 为空表示当前包未接入卡密系统，界面照常放行。
 */
object LicenseConfig {
    private val raw: String = BuildConfig.LICENSE_SERVER.trim()

    val baseUrl: String = raw.trimEnd('/')

    val enabled: Boolean
        get() = baseUrl.startsWith("http://") || baseUrl.startsWith("https://")
}
