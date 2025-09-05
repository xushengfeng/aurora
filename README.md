# Aurora

极光，一个 aur 助手

## 特色

-   支持方向键交互选择
-   自带 GitHub 镜像（这个是软件包构建时需要的）
-   可使用 GitHub aur 镜像（这个是包索引，用于检查包更新， https://github.com/archlinux/aur ）
-   构建时可同时下载多个文件

## 使用

安装 deno

```shell
sudo pacman -S deno
```

运行

```shell
deno run src/main.ts
```

或者直接给权限

```shell
deno run -A src/main.ts
```

编译

```shell
deno run build
```

你可以把`dist/aurora` 复制到`~/.local/bin`下

## TODO

现在只有更新功能

-   [ ] 添加软件
-   [ ] tab 补全支持
-   [ ] 兼容 pacman

## 配置

默认启用了镜像，包索引之类的还是官方的。

创建`~/.config/aurora/config.json`。

```ts
type Config = {
    "index.useGithub": boolean; // 默认为false
    "index.url": string; // 默认为 https://aur.archlinux.org/rpc/?v=5 或 https://api.github.com/graphql 可覆盖
    "github.token": string; // 在使用index.useGithub 或 pkg.useGithub 时必须
    "pkg.useGithub": boolean; // 默认为false
    "pkg.url": string; // 默认为 https://aur.archlinux.org/$pkgname.git 或 https://github.com/archlinux/aur.git 可覆盖
    "build.useMirror": boolean; // 默认为true
    "build.mirrorList": {
        // 配置后将覆盖原有的镜像，src为查找的字符或正则，to为要转换的内容。只用于构建，不用于索引
        src: string;
        type: "git" | "http";
        regex?: true;
        to: string;
    }[];
};
```

比如，要启用 GitHub AUR 镜像：

```json
{
    "index.useGithub": true,
    "github.token": "ghp_your_token",
    "pkg.useGithub": true,
    "pkg.url": "https://hub.gitmirror.com/https://github.com/archlinux/aur"
}
```

如果想在索引中启用镜像，需要手动修改`index.url`或`pkg.url`。不过我没找到`api.github.com`的镜像。

本来 GitHub AUR 镜像为了在官方索引不稳定时提供的后备，但也是访问困难呢。可以安装`watt-toolkit-bin`来加速 GitHub。由于默认启用 GitHub 构建的镜像，就不会有 我访问不了 GitHub -> AUR 安装加速器 -> 安装加速器要访问 GitHub 的死循环 🎉。

## 流程、名词

### 常规 AUR 管理器一般流程

1.检查包索引

通过`pacman -Qm`获取本地安装的 AUR 包

访问`https://aur.archlinux.org/rpc/?v=5`，查询版本更新的

2.下载包构建脚本

下载一个包有`PKGBUILD`的仓库，一般使用`https://aur.archlinux.org/$pkgname.git`。这里面只有简单的几个文本。

3.构建

使用`makepkg`，这个系统自带的命令会根据`PKGBUILD`或`.SRCINFO`下载二进制数据或源代码，执行编译构建。

生成`.pkg.tar.zst`包

4.安装

`pacman -U .pkg.tar.zst`安装

### 镜像

我们注意到，索引、下载包、构建都需要范围网络。

索引和下载需要访问 arch 官方，可能不稳定。所以可以用 https://github.com/archlinux/aur 来做备用。

当然大头还是构建，构建需要访 GitHub，比如代码需要从 GitHub 上克隆，二进制文件需要从 GitHub 的 release 下载。

设置`makepkg`的镜像很麻烦。

所以 aurora 不使用`makepkg`来下载构建数据文件，而是用 deno 自带的`fetch`来下载，这样做镜像很方便。同时也可以实现多文件并行下载。
