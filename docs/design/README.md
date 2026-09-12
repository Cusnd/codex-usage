# Codex 用量图录设计

本地真实数据与在线示例共用同一套前端。公开截图均使用合成数据。

本轮改造的根目标：**将本地面板改造为多设备云端面板，支持分别查看和融合查看多设备信息。** 用户已批准实施；效率与正确性是质量要求，采集／解析／同步实验为该目标提供部分验证，不能代替完整产品验收。

- [订阅默认计价与 Fast 识别升级：实现、历史回补及本地／云端验收（2026-09-12）](fast-subscription-pricing-upgrade-2026-09-12.md)
- [所选 9 项修复及定向复验，S05 仍待处理（2026-09-12）](multi-device-cloud-panel-fixes-2026-09-12.md)
- [修复前全面验收：10 项功能与显示合理性缺陷及原始证据（2026-09-12）](multi-device-cloud-panel-acceptance-2026-09-12.md)
- [当前实施记录：进度、验证及未完成项](multi-device-cloud-panel-implementation-progress-2026-09-11.md)
- [当前方案入口：多设备云端面板具体实施方案（2026-09-11，含模块、v3 协议、迁移与 M0–M7 验收，已批准实施）](multi-device-cloud-panel-implementation-plan-2026-09-11.md)
- [当前需求入口：多设备云端面板批阅后需求（2026-09-11，已整合批注与补充答复）](multi-device-cloud-panel-requirements-2026-09-11.md)
- [用户批阅原稿：多设备云端面板完整需求与设计思考（原样保留）](multi-device-cloud-panel-working-draft-2026-09-11.md)
- [多设备云端面板需求对齐存档（2026-09-11，含批阅收敛、根目标与全流程待验证清单）](sync-rework-2026-09-11.md)
- [采集、解析与同步算法和数据结构方案（2026-09-11，候选，附合成编码实验）](sync-pipeline-algorithms-2026-09-11.md)
- [增量同步协议与算法验证补充（2026-09-11，候选，附增量实验和状态模型）](sync-protocol-contract-2026-09-11.md)
- [同步上行与云端查询研究建议（2026-09-11，独立调研，未批准实施）](sync-upload-recommendation-2026-09-11.md)
- [100k 真实用量派生实云压力测试（2026-09-11，含失败、分段恢复与成本）](../../experiments/parser-placement-v3/REPORT.md)
- [100k 首次完整云端构建优化（2026-09-11，CUA 五次全部低于 15 秒）](../../experiments/parser-placement-v4/REPORT.md)
- [最终算法优化与同资源 A/B（2026-09-11，完整构建中位 6.098 秒、CPU 降低 32.1%）](../../experiments/parser-placement-v5/REPORT.md)
- [新版采集器实验（2026-09-11，真实日志到上传包中位 3.475 秒、完整回放一致）](../../experiments/collector-v1/REPORT.md)

- [ATLAS 交互动效规范、实现与验收（2026-09-09）](motion-2026-09-09.md)

- [ATLAS 视觉系统、组件拆分与浏览器验收](atlas-refinement/README.md)
- [本地真实模式与在线示例的共用前端验收](shared-frontend/README.md)
- [README 截图与复现步骤](../images/README.md)
- [示例构建、发布与回退](../../showcase/README.md)
