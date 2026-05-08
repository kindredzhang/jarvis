/**
 * 其余通道 —— 钉钉 / 企微 / Slack / 通用 WebSocket / Email / QQ / Matrix / Teams
 *
 * 所有通道遵循相同模式：
 * - extends BaseChannel
 * - start() / stop() / send() 生命周期
 * - onMessage 回调处理入站消息
 *
 * ========= 未实现通道 =========
 * 以下通道在 Python 原版中存在但暂未实现完整逻辑：
 * - Slack：Event API + Web API（需 Slack App + Bot Token）
 * - DingTalk：钉钉机器人 webhook（需 access_token）
 * - WeCom：企业微信机器人 webhook（需 key）
 * - Email：IMAP 收信 + SMTP 发信（需邮箱配置）
 * - Matrix：Matrix 协议（需 homeserver + access_token）
 * - QQ：QQ 机器人 API（需 appid + token）
 * - MSteams：Microsoft Teams（需 Bot Framework）
 * - MoChat：摩卡
 * - WebSocket：通用 WebSocket 通道
 */
