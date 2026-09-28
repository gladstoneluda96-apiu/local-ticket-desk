# 数据与规则补充

## 1. 数据表

### ticket

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| id | INTEGER | 主键，自增 |
| local_id | TEXT | `LOC-{UUID v4}`，UNIQUE，NOT NULL |
| reporter | TEXT | AI 识别，可编辑 |
| summary | TEXT | AI 识别，可编辑，建议 30 字以内 |
| description | TEXT | AI 识别，可编辑 |
| context | TEXT | AI 识别，可编辑 |
| menu_path | TEXT | AI 识别，可编辑 |
| report_time | DATETIME | AI 识别，失败时取当前时间 |
| status | TEXT | 待处理 / 已处理 / 待验证 / 待反馈 |
| external_id | TEXT | 人工维护 |
| handler | TEXT | 人工维护 |
| remark | TEXT | 人工维护 |
| priority | TEXT | 低 / 中 / 高 / 紧急 |
| ai_source | TEXT | local / cloud / mixed |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

建议索引：

- `idx_ticket_local_id`
- `idx_ticket_external_id`
- `idx_ticket_status`
- `idx_ticket_report_time`
- `idx_ticket_created_at`

### ticket_attachment

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| id | INTEGER | 主键，自增 |
| ticket_id | INTEGER | 关联 ticket.id |
| file_path | TEXT | 本地文件路径 |
| file_name | TEXT | 原始文件名 |
| mime_type | TEXT | PNG / JPG / WEBP |
| file_size | INTEGER | 字节数 |
| ocr_text | TEXT | OCR 结果 |
| created_at | DATETIME | 创建时间 |

### ticket_log

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| id | INTEGER | 主键，自增 |
| ticket_id | INTEGER | 关联 ticket.id |
| action_type | TEXT | create / update_field / change_status / ai_parse / export |
| field_name | TEXT | 变更字段 |
| old_value | TEXT | 变更前 |
| new_value | TEXT | 变更后 |
| operator | TEXT | 本机用户或手动填写 |
| ai_source | TEXT | local / cloud / mixed |
| created_at | DATETIME | 操作时间 |

### app_config

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| key | TEXT | 配置键 |
| value | TEXT | 配置值 |
| updated_at | DATETIME | 更新时间 |

API Key 不进入 `app_config`，统一存放在系统密钥库。

## 2. 本地工单号规则

- 完整形式：`LOC-7f3a2b1c-9d4e-4a8b-b6c2-1e5d8f9a0c3e`
- UI 短码：`LOC-7F3A2B`
- 短码取 UUID 前 6 位并转大写。
- 完整值用于导出、详情、复制、跨设备合并预留。
- 短码用于列表展示和快速沟通。

## 3. 识别置信度规则

建议每个字段保留独立置信度：

| 字段 | 低置信处理 |
| --- | --- |
| 反馈人 | 置空，显示待补充 |
| 问题概括 | 使用描述前 30 字生成草稿，并标记低置信 |
| 操作菜单 | 置空，显示待补充 |
| 反馈时间 | 使用系统当前时间，并标记推断 |

触发自动兜底的关键字段：

- 反馈人
- 问题概括
- 操作菜单

任一字段缺失或置信度低于阈值，且用户开启自动兜底，则进入云端解析。

## 4. 脱敏规则

开启数据脱敏后，发送到云端前执行掩码：

| 类型 | 示例 | 掩码 |
| --- | --- | --- |
| 手机号 | 13812345678 | 138****5678 |
| 邮箱 | user@example.com | u***@example.com |
| 身份证号 | 110101199001011234 | 110101********1234 |
| 银行卡号 | 6222020202020202020 | 622202********2020 |

建议后续允许用户新增自定义正则脱敏规则，用于内部项目代号、订单号等企业特定信息。

## 5. 状态规则

| 当前状态 | 可流转到 | 说明 |
| --- | --- | --- |
| 待处理 | 已处理 | 处理完成 |
| 已处理 | 待验证 | 提交核对 |
| 待验证 | 待反馈 | 验证通过 |
| 待验证 | 待处理 | 验证不通过 |
| 待反馈 | 归档销号 | 闭环结束 |

MVP 可以允许用户直接选择任意状态，但需要记录日志。正式版本建议按状态机限制，减少状态跳跃造成的审计混乱。

## 6. 导出字段

导出顺序建议：

1. 本地工单号
2. 外部工单号
3. 状态
4. 优先级
5. 反馈人
6. 问题概括
7. 问题描述
8. 问题背景
9. 操作菜单
10. 反馈时间
11. 处理人
12. 处理备注
13. AI 来源
14. 附件数量
15. 创建时间
16. 更新时间

## 7. 安全规则

- 默认不联网。
- 默认不上传截图、文本、识别结果。
- 首次开启云端兜底必须展示合规提示。
- API Key 使用系统密钥库。
- 云端请求失败不阻塞工单创建。
- 日志记录是否调用云端，以及调用结果，不记录 API Key。
