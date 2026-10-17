# dsh-web-search-free

零密钥、零费用的 `web_search` 后端，给 DeepSeek Harness 用。抓取走**本机 Edge 浏览器**。

## 它解决的是什么坑

DSH 自带的 `deepseek-official` 搜索提供方没有独立搜索接口，它把一次搜索实现成**一次完整的
Messages 模型调用**（带上服务端的 `web_search_20250305` 工具），抓到的网页正文就是输入
token。于是每次 `web_search` 都真实扣一次 DeepSeek 余额——哪怕你聊天的模型是别人家的，
搜索这一下仍然记在你自己的账上。

本插件改成直接读搜索结果页，归一化成 `ctx.web` 需要的 `WebSearchResult`：无密钥、不调模型、
不计费。它注册进同一个 `ctx.web` 破缝，`dsh-tool-web` 依旧负责模型侧的 `web_search` 契约。

## 为什么用 Edge 而不是 HTTP 抓取

值得用的中文引擎都是**客户端渲染**的：服务器发回来的 HTML 里根本没有结果卡片，结果由页面
自己的 JavaScript 填充。HTTP 抓取永远看不到它们，Edge 渲染后就能拿到。

实测（本机，`--headless=new --dump-dom`）：

| 引擎 | 通道 | 实测 |
|---|---|---|
| **神马 `m.sm.cn`** | **Edge 渲染** | 渲染后 372 KB，稳定 10 条结果，标题/来源/真实 URL 齐全，无广告位，**不限流** |
| **Bing** | HTTP | 250–450 ms，10 条。HTML 里就有结果，渲染它反而要 5.5 秒，纯属浪费 |
| 360 | — | 按出口 IP 限流，连着几次整机进验证码。**已从本插件移除** |
| 百度 / 搜狗 / Quark | Edge 渲染 | 仍然被验证码或反爬页拦住，不可用 |

**关键否定结果**：360 和百度的拦截是**按出口 IP**的，不是按指纹。用真实 Edge 无头跑同一个
URL，拿到的还是同一个验证码页。所以这类引擎不是"换个浏览器就能过"，而是没有价值，已删除。

## 引擎与通道

```yaml
transport: auto      # 默认：每个引擎走自己能用的通道
```

| `transport` | 行为 |
|---|---|
| `auto`（默认） | 神马走 Edge 渲染（约 4–5 秒），Bing 走 HTTP（约 0.3 秒）。**正确且最快** |
| `browser` | 全部走 Edge 渲染。最慢，但完全不受 HTTP 层拦截影响 |
| `http` | 全部走普通抓取。最快；神马这类客户端渲染的引擎会明确报告"渲染型引擎，请用 auto"而不是静默返回空 |

| 引擎 id | 说明 |
|---|---|
| `shenma` | 神马/UC。中文质量最好，走 Edge。 |
| `bing` | 始终可达。英文/技术查询强，但按源 IP 定位，本地中文查询会漂移到别的城市。 |

旧 id 会被映射，配置写错不会让整个搜索挂掉：

```
smcn / sm / uc / shenma-mobile  →  shenma
bing-html / google / duckduckgo →  bing
```

## 四个关键机制

**相关性闸门（按稀有度加权）**。一个词如果每条候选里都有（"下载"、"天气"），它不能区分答案；
只在少数页面出现的词（`works2`、`stm32f103`、`梯形图`）才决定相关性。所以每个词按
`1 / (0.5 + 文档频率/候选数)` 加权，并且命中至少要落在**一个有区分度的词**上，否则整条丢掉。
标题命中权重 2、URL 1.5、摘要 1。

**答非所问提示**。Bing 会按 IP 地理位置给答案，而且给得很自信。所以当最终结果没有覆盖查询里
的**区分性词**（例如问"上海"却全是滨州的页面），插件不假装成功：照常返回结果，但在 `content`
里写一句"这些来源没覆盖 X，是最接近的匹配而非确认答案"。`dsh-tool-web` 会把 `content` 印在
来源列表上方，模型能自己决定要不要换词重查。

**限流冷却**。引擎返回验证码/反爬页时记一笔，默认 10 分钟内不再问它——反复戳验证码端点只会
让 IP 关得更久，而且每次重试都把整次搜索拖到超时。冷却中的引擎不会在每次搜索里刷提示，只有
在结果确实可疑、或只剩一个引擎答上来时才会说明。

**同站限额**。`blog.csdn.net` 和 `bbs.csdn.net` 是两个 host、一个站。默认同一注册域最多占 3
条；超出名额在别的站不够用时再回填，所以限额不会缩短结果集。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `engines` | `[shenma, bing]` | 引擎列表，顺序仅用于打平。 |
| `maxResults` | `8` | 单次搜索返回上限。 |
| `maxPerSite` | `3` | 同一注册域最多几条。 |
| `timeoutMs` | `15000` | 单个 HTTP 请求预算。 |
| `transport` | `auto` | `auto` / `browser` / `http`，见上表。 |
| `browserPath` | `""` | 显式指定 Edge；空则自动探测（`DSH_SEARCH_BROWSER` / `DSH_EDGE_PATH` 也可）。 |
| `browserTimeoutMs` | `30000` | 单次无头渲染预算。 |
| `cooldownMs` | `600000` | 被限流后跳过多久。 |
| `minAnchorCoverage` | `0.75` | 结果要覆盖多少比例的区分性词，低于此值才出提示；`0` 关闭。 |
| `debugDomDir` | `""` | 填一个目录就把每次渲染的 DOM 存下来，便于排查页面改版。 |

### Edge 的用法与隐私

渲染用 `msedge --headless=new --dump-dom <url>`，**每次都用全新的临时 profile 目录**，用完即删。
它不会读写你真实的 Edge 配置、历史、cookie 或扩展，也不会和你已经打开的 Edge 窗口冲突。
`--virtual-time-budget=9000` 让渲染器快速推进定时器，这样结果填完才截图 DOM。

## 接线

profile 的 `cordis.patch.yml`：

```yaml
- id: web
  config:
    searchProvider: free-scrape
    fetchProvider: http
- id: web-search-deepseek
  disabled: true          # 计费的那条提供方直接关掉，写错配置也只会报错不会扣钱
- insert:
    - id: web-search-free
      name: dsh-web-search-free
      config:
        engines: [shenma, bing]
        transport: auto
```

`web-fetch-http` 仍是 fetch 提供方，`web_fetch` 一直是免费的，没有变化。

## 取舍

- 结果就是引擎给的结果：标题、URL、摘要，**永远没有合成答案**（`content` 只用来放上述提示），
  模型拿来源自己去 `web_fetch`。
- 走 Edge 的神马通道每次约 4–5 秒，主要开销是 Edge 启动本身；实测把渲染预算从 9 秒降到 4 秒
  对结果数量没有影响，所以预算是够用就好，不是越大越好。
- 中文长尾质量取决于神马是否可达；只剩 Bing 时本地化查询可能偏移，插件会明说，不会装作答上了。
- 抓取受各引擎自身条款约束；这是给个人低频率查询用的，不是批量爬取。

## 回滚

删掉 profile patch 里的三段（`web` 覆盖、`web-search-deepseek` 禁用、`web-search-free` insert），
`searchProvider` 回到默认的 `deepseek-official`。改完重启 DSH 生效。
