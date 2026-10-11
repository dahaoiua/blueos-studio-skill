# 设备外壳素材

`shot --shell` 使用的设备外观图片，用于把模拟器画面合成为带外壳的截图。

| 文件 | 尺寸 | 设备 |
| --- | --- | --- |
| `watch-round.png` | 565 × 897 | 圆表（`watch-round`） |
| `watch-square.png` | 446 × 799 | 方表（`watch-square`） |
| `phone.png` | 420 × 900 | 手机（`phone`） |
| `foldable.png` | 3000 × 3343 | 折叠屏（`foldable`） |
| `tablet.png` | 1990 × 1436 | 平板（`tablet`） |
| `tv.png` | 1554 × 939 | 电视（`tv`） |

`car`、`multi` 无对应素材，命中外壳截图时会输出原始画面并给出提示。

## 来源与许可

素材取自 vivo BlueOS Studio 安装包：

```
<Studio>/resources/app/extensions/blueos-previewer/client/
```

版权归 vivo 所有，不在本仓库的 MIT 许可范围内，仅用于本工具的截图合成。
删除本目录不影响使用，程序会改用本机 Studio 安装目录中的同名文件。
