# pi-meguru

[English](README.md) | 简体中文

为 Pi codemode 提供轻量级 DAG 编排。

## 安装

需要先在 Pi 内启用 `codemode` 工具，此插件才会生效。

```sh
pi install npm:pi-meguru
```

## 工作原理

扩展会在模型看到的 codemode 工具描述开头加入 meguru 的组合模型和 API 说明。普通 codemode 脚本仍然可用；meguru 可以用原生 JS 将多个阶段组织为一次可续跑的 flow，不再需要单独的 skill。

一个节点就是一次独立的 PTC，用 `ptc(name, fn)` 定义。编排就是普通的 async JS，写在 `flow(name, fn, opts)` 里：分支用 `if`，循环用 `for`，节点之间用参数传递输出。

脚本调用 `flow()` 时，扩展把运行时和已保存的记录追加到脚本末尾，一起交给 codemode 的 QuickJS 执行，工具调用沿用 Pi 原有的权限和 hook。

- **续跑**：每次发送都从头执行编排函数。节点按作用域内的实例标识（`name#k`）查找记录，源码和 JSON 参数都没变就复用输出。插入或重排不同名字的节点不影响其他记录；源码或参数变化只使该实例重跑，下游参数变化时再重跑下游。
- **`pause`**：停下并返回 `paused`，控制权回到模型。再次发送同一个脚本，就从暂停处继续。
- **`watch`**：每个节点完成后求值，只记录变化，不打断执行。记录随 `flow()` 的结果返回。

记录只存在扩展进程的内存里，不写进 session。flow 完成、切换会话或在会话树里跳转时清空。节点之间不能调用工具，因为这部分代码每次发送都会重跑。

## 子流程与批量节点

`group(name, fn)` 为普通 JS 编排提供独立作用域和一个外层 trace 节点。续跑时重新执行编排，内部叶子节点分别复用记录。group 可以调用节点、其他 group 和 `pause()`；工具调用放在叶子 `ptc()` 中。节点和 group 要依次 await，叶子节点内部的工具调用仍可并行。

```js
const check = ptc("check", task => tools.bash({ command: task.command }))
const verify = group("verify", async task => {
  const result = await check(task)
  if (task.review) await pause("review")
  return { name: task.name, result }
})

return flow("release", () => verify.map([
  { name: "lint", command: "npm run lint", review: false },
  { name: "test", command: "npm test", review: true },
], { key: task => task.name }))
```

节点和 group 都有 `.map(items, { key })`。批量本身是一个 trace 节点，内部记录放在 `children` 中，按输入顺序依次执行并返回。key 必须是不重复的字符串或有限数值，各项按 key 保持身份，所以插入、删除或重排其他项不会使它们失效。出错或暂停会停止批量，重发脚本后复用已完成项并继续。父作用域的 watch 可以读取 group 输出和完整批量数组；group 内的 watch 读取本作用域的节点输出。

内部标识例如 `verify.map#1/[%22test%22]/verify#1/check#1`，名字和 key 会编码，避免路径混淆。同名调用仍按出现次数编号，插入同名调用会移动后面的编号；多个批量可用不同名字的 group 隔离身份。

重试、管道、降级链仍然用原生高阶函数组合。捕获异常的组合函数先判断 `if (isFlowStop(error)) throw error`，让暂停和存档失败原样传播，再处理业务失败。每次重试有独立记录，不会自动暂停。

变化的依赖要通过参数传递。新节点修改了外部文件，并不会自动使参数不变的下游调用失效。修改脚本后，已访问过的暂停点也会继续复用；需要再次检查时，改暂停点名字或用 `fresh: true`。

## 测试

```sh
npm test
node test/pi-smoke.mjs
```

## 示例

[猫猫远征队](example.js)：只读巡查代码仓库，使用结构化的 `glob` 和 `grep` 搜索结果。先让侦察员前往源码工坊、测试训练场和文档图书馆，再由 **糯米队长 Captain Mochi 🐱** 接手指挥：

- 根据采样里的标记和覆盖缺口生成任务，计算优先级并排序。
- 按任务预算派出复查小队，每个街区再按标记类型展开嵌套的 keyed map。
- 用原生高阶函数重试失败的搜索；结果不完整时扩大一次采样，仍取不到证据则保留缺口。
- 汇总发现、覆盖缺口和未派出的任务，决定是否在队长子流程中暂停审阅。

重发同一脚本会复用已完成的搜索和已捕获的失败记录，继续生成报告；完整且没有标记的巡查直接结束。展开 trace 可以看到 `captain → mission.map → mission → lead.map → lead → inspect` 的层级。watch 会在各作用域记录阶段结果，暂停时可以看到任务板。

开始前将 `root` 改成仓库路径。示例需要结构化搜索结果（`items`、`total`、`scanComplete`、`pageComplete`、`hasMore`，以及可选的 `failed` / `skippedFiles`）；请按可用搜索工具调整 `scout`、`patrol` 和 `inspect` 节点。`missionBudget` 控制最多复查几个街区，默认 2。无需 shell、Python 或预先准备样例文件。采样和工具的遍历排除规则会限制覆盖范围；标记只是待检查线索，不代表已确认的 bug，`no-markers-observed` 也不代表整个仓库没有问题。
