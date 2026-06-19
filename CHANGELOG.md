# ChangeLog

## 2026-06-19 16:00

- 修复视频纸面文字的基线对齐问题：生辰行统一使用 `Xingkai.ttc` 渲染，避免数字和中文跨字体顶部对齐导致基线不齐。
- 调整姓名行手写抖动：固定每行字符字号，仅保留 `dx/dy` 小幅位置抖动，避免字号变化造成上下波浪。
- 增加 `scripts/render-baseline-fixtures.cjs` 验证脚本，并输出 `pr-evidence/text-baseline/` before/after 第 3 秒抽帧与纸面放大图。
- 验证：使用 `bin/win/ffmpeg.exe` 跑通 `王先生 / 1991年农历八月初六`、`欧阳娜娜 / 2000年1月1日` 两组样例。
