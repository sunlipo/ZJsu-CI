package me.weishu.kernelsu.ui.util

/**
 * 钻酱SU 的唯一对外入口。
 *
 * 管理器里所有原本指向项目地址、关于页、反馈、捐赠的点击，全部收敛到作者快手的这一个地址，
 * 需要改链接时只动这里。
 */
object AuthorLinks {
    const val KUAISHOU_URL: String =
        "https://estplca.m.chenzhongtech.com/fw/user/ykmsnb666?cc=share_wxms&kpf=ANDROID_PHONE" +
            "&fid=3770392881&shareMode=app&shareMethod=picture&appType=21&kpn=KUAISHOU" +
            "&subBiz=QR_CODE_PROFILE&shareId=19182963972868&shareToken=YgBX4dpKc" +
            "&shareObjectId=3770392881"

    /** 泪痕 的快手主页。 */
    const val LEIEN_KUAISHOU_URL: String =
        "https://estplcb.m.chenzhongtech.com/fw/user/3xig7abimqjednu?cc=share_wxms&kpf=ANDROID_PHONE" +
            "&fid=3376714443&shareMode=app&shareMethod=picture&appType=21&kpn=KUAISHOU" +
            "&subBiz=QR_CODE_PROFILE&shareId=19182934406574&shareToken=YgDmQS2R2" +
            "&shareObjectId=3376714443"

    /** The author's display name used by the about sheet and the support card. */
    const val AUTHOR_NAME: String = "钻酱"

    /** One-line label shared by every entry that opens the author's feed. */
    const val AUTHOR_LABEL: String = "作者快手"
}
