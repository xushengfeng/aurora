import { checkbox, confirm, select } from "@inquirer/prompts";
import { copySync, ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { blue, bold, gray, green, red } from "yoctocolors";
import { changeOut } from "./simple_tui.ts";

export { parsePkgData };

// 基础包信息（search和multiinfo共有）
interface PackageBaseInfo {
	ID: number;
	Name: string;
	PackageBaseID: number;
	PackageBase: string;
	Version: string;
	Description: string;
	URL: string;
	NumVotes: number;
	Popularity: number;
	OutOfDate: number | null;
	Maintainer: string | null;
	FirstSubmitted: number;
	LastModified: number;
	URLPath: string;
}

// 扩展包信息（仅multiinfo类型包含）
interface PackageExtendedInfo {
	Depends: string[];
	MakeDepends: string[];
	OptDepends: string[];
	CheckDepends: string[];
	Conflicts: string[];
	Provides: string[];
	Replaces: string[];
	Groups: string[];
	License: string[];
	Keywords: string[];
}

// 完整的包信息类型
type PackageInfo = PackageBaseInfo & Partial<PackageExtendedInfo>;

type AURError = {
	type: "error";
	version: 5;
	resultcount: 0;
	results: [];
	error: string;
};

type AURSearchResponse =
	| {
			type: "search";
			version: 5;
			resultcount: number;
			results: PackageBaseInfo[];
	  }
	| AURError;

type AURMultiInfoResponse =
	| {
			type: "multiinfo";
			version: 5;
			resultcount: number;
			results: PackageInfo[];
	  }
	| AURError;

type UrlX = {
	name: string;
	url: string;
	type: "http" | "git";
};

const sumK = [
	"b2",
	"sha512",
	"sha384",
	"sha256",
	"sha224",
	"sha1",
	"md5",
	"ck",
] as const;

type SumsObj = Record<
	`${(typeof sumK)[number]}sums${"_x86_64" | ""}`,
	string[]
>;

type PkgData = ReturnType<typeof parsePkgData>;

type Config = {
	"index.useGithub": boolean;
	"index.url": string;
	"github.token": string;
	"pkg.useGithub": boolean;
	"pkg.url": string;
	"build.useMirror": boolean;
	"build.mirrorList": typeof urlMappingList;
	"build.download.concurrent": number;
};

const appName = "aurora";

const config = (() => {
	try {
		const text = Deno.readTextFileSync(
			join(
				(Deno.env.get("XDG_CACHE_HOME") ?? Deno.env.get("HOME")) || "/",
				".config",
				appName,
				"config.json",
			),
		);
		return JSON.parse(text);
	} catch (error) {}
	return {};
})() as Partial<Config>;

const aurUrl = config["index.url"] ?? "https://aur.archlinux.org/rpc/?v=5";
const githubAurUrl = config["index.url"] ?? "https://api.github.com/graphql";
const githubToken = config["github.token"] ?? "";
const useGithubIndex = config["index.useGithub"] ?? false;
const useGithub = config["pkg.useGithub"] ?? false;
const aurPackageUrl =
	config["pkg.url"] ?? "https://aur.archlinux.org/$pkgname.git";
const aurPackageUrlKey = "$pkgname";
const aurPackageUrlGithub =
	config["pkg.url"] ?? "https://github.com/archlinux/aur.git";
const basePath = join(
	(Deno.env.get("XDG_CACHE_HOME") ?? Deno.env.get("HOME")) || "/",
	".cache",
	appName,
);
const pkgbuildPath = join(basePath, "pkgbuild");
const buildPath = join(basePath, "build");

const thisArch = "x86_64";

const urlMappingList: {
	src: string;
	type: "git" | "http";
	regex?: true;
	to: string;
}[] =
	(config["build.useMirror"] ?? true)
		? (config["build.mirrorList"] ?? [
				{
					src: "https://raw.githubusercontent.com",
					type: "http",
					to: "https://raw.gitmirror.com",
				},
				{
					src: "https://github.com",
					type: "http",
					to: "https://hub.gitmirror.com/https://github.com",
				},
				{
					src: "https://github.com",
					type: "git",
					to: "https://hub.gitmirror.com/https://github.com",
				},
			])
		: [];

const downloadConcurrent = config["build.download.concurrent"] ?? 4;

const Color = {
	pkgName: (text: string) => bold(blue(text)),
	pkgVer: (text: string) => bold(green(text)),
	filePath: (text: string) => gray(text),
	url: (text: string) => blue(text),
	warn: (text: string) => `${bold(blue("Warning:"))} ${text}`,
	error: (text: string) => `${bold(red("Error:"))} ${text}`,
	task: (text: string) => bold(`${blue("::")} ${text}`),
};

const xLog = {
	warn: (text: string) => console.log(Color.warn(text)),
	error: (text: string) => console.log(Color.error(text)),
	task: (text: string) => console.log(Color.task(text)),
};

async function exists(file: string, op?: { isFile: boolean }) {
	try {
		const stats = await Deno.lstat(file);
		if (op) {
			if (op.isFile && stats.isFile) {
				return true;
			} else {
				return false;
			}
		} else {
			return true;
		}
	} catch (err) {
		if (!(err instanceof Deno.errors.NotFound)) {
			throw err;
		}
		return false;
	}
}
function existsSync(file: string, op?: { isFile: boolean }) {
	try {
		const stats = Deno.lstatSync(file);
		if (op) {
			if (op.isFile && stats.isFile) {
				return true;
			} else {
				return false;
			}
		} else {
			return true;
		}
	} catch (err) {
		if (!(err instanceof Deno.errors.NotFound)) {
			throw err;
		}
		return false;
	}
}

function getLocalAurList() {
	const x = new Deno.Command("pacman", {
		args: ["-Qm"],
		stdout: "piped",
	}).outputSync();
	const out = new TextDecoder().decode(x.stdout);
	return out
		.trim()
		.split("\n")
		.map((l) => {
			const [name, v] = l.split(" ");
			return { name, version: v };
		});
}

async function getAurInfo(
	names: string[],
	useGithub?: boolean,
): Promise<AURMultiInfoResponse> {
	if (!useGithub) {
		const url = new URL(aurUrl);
		url.searchParams.set("type", "info");
		for (const name of names) {
			url.searchParams.append("arg[]", name);
		}
		const res = await fetch(url.toString());
		const data = (await res.json()) as AURMultiInfoResponse;
		if (data.type === "error") {
			throw new Error(data.error);
		}
		return data;
	} else {
		const graphqlUrl = githubAurUrl;
		const graphql =
			"{" +
			names
				.map(
					(i, index) => `
			a${index}: repository(name: "aur", owner: "archlinux") {
				object(expression: "${i}:.SRCINFO") {
					... on Blob {
						text
					}
				}
			}`,
				)
				.join("\n") +
			"}";
		const x = (await (
			await fetch(graphqlUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${githubToken}`,
				},
				body: JSON.stringify({ query: graphql }),
			})
		).json()) as {
			data: Record<string, { object: { text: string } | null } | null>;
		};

		const r = Object.entries(x.data).flatMap(([, v]) => {
			if (!v || !v.object || !v.object.text) {
				return [];
			}
			const x = parsePkgData(v.object.text);
			const base: PackageBaseInfo & Partial<PackageExtendedInfo> = {
				ID: 0,
				Name: x.keyName,
				PackageBaseID: 0,
				PackageBase: x.keyName,
				Version: getPkgVersion(x),
				Description: x.pkgdesc ?? "",
				URL: x.url ?? "",
				NumVotes: 0,
				Popularity: 0,
				OutOfDate: null,
				Maintainer: null,
				FirstSubmitted: 0,
				LastModified: 0,
				URLPath: "",
				Depends: x.depends ?? [],
				MakeDepends: x.makedepends ?? [],
				OptDepends: x.optdepends ?? [],
				CheckDepends: x.checkdepends ?? [],
			};
			return base;
		});
		return {
			type: "multiinfo",
			version: 5,
			resultcount: r.length,
			results: r,
		} as AURMultiInfoResponse;
	}
}

function vercmp(a: string, b: string): number {
	const com = new Deno.Command("vercmp", {
		args: [a, b],
		stdout: "piped",
	}).outputSync();
	const out = new TextDecoder().decode(com.stdout);
	return parseInt(out.trim(), 10);
}

async function getNewPackages() {
	const localPackages = getLocalAurList();
	const aurPackages = await getAurInfo(
		localPackages.map((p) => p.name),
		useGithubIndex,
	);
	const newPackages = aurPackages.results.flatMap((p) => {
		const local = localPackages.find((lp) => lp.name === p.Name); // todo eq?
		return local && vercmp(p.Version, local.version) > 0
			? [{ local, remote: p }]
			: [];
	});
	return newPackages;
}

async function fetchFile(
	url: string,
	path: string,
	onStart?: (size: number) => void,
	onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
	let file: Deno.FsFile | null = null;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	try {
		const res = await fetch(url);

		if (!res.ok) {
			throw new Error(
				`Failed to fetch ${url}: ${res.status} ${res.statusText}`,
			);
		}

		// 获取内容长度
		const contentLength = res.headers.get("content-length");
		const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
		if (onStart) onStart(totalBytes);

		if (!res.body) {
			throw new Error("Response body is null");
		}

		reader = res.body.getReader();
		let receivedBytes = 0;

		// 创建文件并准备流式写入
		file = await Deno.open(path, {
			create: true,
			write: true,
			truncate: true,
		});

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			// 直接写入文件
			await file.write(value);
			receivedBytes += value.length;

			if (onProgress) {
				onProgress(receivedBytes, totalBytes);
			}
		}

		// 确保最终进度回调
		if (onProgress && totalBytes > 0) {
			onProgress(totalBytes, totalBytes);
		}
	} catch (error) {
		// 清理部分下载的文件
		try {
			if (file) file.close();
			await Deno.remove(path).catch(() => {}); // 忽略删除错误
		} catch (cleanupError) {
			console.warn("清理文件时出错:", cleanupError);
		}

		throw error; // 重新抛出错误
	} finally {
		// 确保资源被释放
		if (reader) {
			reader.releaseLock();
		}
		if (file) {
			try {
				file.close();
			} catch (error) {}
		}
	}
}
async function fetchGit(
	url: string,
	path: string,
	op?: {
		simple?: boolean;
		showOutput?: boolean;
		srcUrl?: string;
		force?: boolean;
		flags?: string[];
	},
): Promise<boolean> {
	const simple = op?.simple ?? true;
	const showOutput = op?.showOutput ?? false;

	const srcUrl = op?.srcUrl ?? url;

	async function setUrl(u: string) {
		const command = new Deno.Command("git", {
			args: ["remote", "set-url", "origin", u],
			cwd: path,
		}).spawn();
		await command.output();
	}

	if (op?.force) {
		try {
			Deno.removeSync(path, { recursive: true });
		} catch {}
	} else if (await exists(path)) {
		const stat = await Deno.stat(path);
		if (stat.isDirectory) {
			await setUrl(url);
			const command = new Deno.Command("git", {
				args: ["pull"],
				stdout: showOutput ? "inherit" : "piped",
				stderr: "piped",
				cwd: path,
			});

			const { stderr } = await command.output();
			if (stderr.length > 0) {
				Deno.removeSync(path, { recursive: true });
			} else {
				await setUrl(srcUrl);
				return true;
			}
		}
	}

	// 执行 git clone 命令
	const command = new Deno.Command("git", {
		args: ["clone", url, path]
			.concat(simple ? ["--depth", "1"] : [])
			.concat(op?.flags || []),
		stderr: showOutput ? "inherit" : "piped",
		stdout: showOutput ? "inherit" : "piped",
	});

	const { output, status } = command.spawn();

	if (!(await status).success) {
		console.error(new TextDecoder().decode((await output()).stderr));
	} else {
		await setUrl(srcUrl);
	}

	return true;
}

async function getAurPackage(name: string, useGithub?: boolean) {
	const url = aurPackageUrl.replace(aurPackageUrlKey, name);
	const dirPath = join(pkgbuildPath, name);
	if (!useGithub) await fetchGit(url, dirPath);
	else
		await fetchGit(aurPackageUrlGithub, dirPath, {
			flags: ["--branch", name, "--single-branch"],
		});
}

function parsePkgData(data: string) {
	const pkgbuild: {
		keyName: string;
		pkgver: string;
		pkgrel: string;
		epoch?: string;
		pkgdesc?: string;
		url?: string;
		license?: string;
		groups?: string[];
		source: string[];
		source_x86_64?: string[];
		validpgpkeys?: string[];
		makedepends?: string[];
		depends?: string[]; // todo =
		checkdepends?: string[];
		optdepends?: string[]; // :
		arch?: string[];
		provides?: string[];
		conflicts?: string[];
		replaces?: string[];
		children: {
			pkgname: string;
			arch: string[];
		}[];
	} & Partial<SumsObj> = {
		keyName: "",
		pkgver: "",
		pkgrel: "",
		source: [],
		children: [],
	};
	const justStr = [
		"pkgname",
		"pkgver",
		"pkgrel",
		"epoch",
		"pkgdesc",
		"url",
		"license",
	];
	for (const [index, x] of data.split("\n\n").entries()) {
		const xo: Record<string, string | string[]> = {};
		for (const i of x.trim().split("\n")) {
			if (i.startsWith("pkgbase")) {
				xo.keyName = i.slice("pkgbase = ".length).trim();
				continue;
			}
			const eq = i.indexOf("=");
			if (eq === -1) continue;
			const key = i.slice(0, eq).trim();
			const value = i.slice(eq + 1).trim();

			if (key && value) {
				const old = xo[key];
				if (Array.isArray(old)) {
					old.push(value);
				} else if (old) {
					xo[key] = [old, value];
				} else if (!justStr.includes(key)) {
					xo[key] = [value];
				} else {
					xo[key] = value;
				}
			}
		}
		if (index === 0) {
			for (const k of Object.keys(xo)) {
				// @ts-ignore
				pkgbuild[k] = xo[k];
			}
		} else {
			// @ts-ignore
			pkgbuild.children[index - 1] = xo;
		}
	}
	return pkgbuild;
}

function getPkgVersion(data: PkgData) {
	let v = data.pkgver;
	if (data.epoch) v = `${data.epoch}:${v}`;
	if (data.pkgrel) v = `${v}-${data.pkgrel}`;
	return v;
}

function getArch(arch: string[] | undefined, defaultArch = thisArch) {
	if (!arch || arch.length === 0) return defaultArch;
	if (arch.includes("any")) return "any";
	if (arch.includes(defaultArch)) return defaultArch;
	return arch[0];
}

function getPkgNames(data: PkgData): string[] {
	return data.children.map(
		(i) =>
			`${i.pkgname}-${getPkgVersion(data)}-${getArch(i.arch, getArch(data.arch))}.pkg.tar.zst`,
	);
}

function getPkgFile(name: string) {
	const p = join(pkgbuildPath, name, ".SRCINFO");
	if (existsSync(p, { isFile: true })) {
		try {
			return Deno.readTextFileSync(p);
		} catch (error) {
			console.error(`Error reading ${p}:`, error);
		}
	}
	return null;
}

function parseSourceUrl(url: string): UrlX {
	const x = url.indexOf("::");
	let name = "";
	let u = "";
	let type: UrlX["type"] = "http";

	if (x === -1) {
		u = url;
		if (url.startsWith("git+")) {
			name = url
				.split("/")
				.at(-1)!
				.replace(/#.*$/, "")
				.replace(/\.git.*$/, "");
		} else {
			name = url.split("/").at(-1)!;
		}
	} else {
		u = url.slice(x + 2);
		name = url.slice(0, x);
	}

	if (u.startsWith("git+")) {
		u = u.slice(4);
		const a = u.split("/").at(-1)!;
		const aa = u.split("/").slice(0, -1).join("/");
		u = `${aa}/${a.replace(/#.*$/, "").replace(/\.git.*$/, "")}`;
		type = "git";
	}

	if (u.startsWith("https://") || u.startsWith("http://")) {
		const urlObj = new URL(u);
		let path = urlObj.pathname;
		path = path.replace(/\/\/+/g, "/");
		urlObj.pathname = path;
		u = urlObj.toString();
	}

	return {
		name,
		url: u,
		type,
	};
}

function cpMeta(name: string) {
	const fromP = join(pkgbuildPath, name);
	const toP = join(buildPath, name);
	ensureDirSync(toP);
	for (const i of Deno.readDirSync(fromP)) {
		if (i.name === ".git") continue;
		try {
			copySync(join(fromP, i.name), join(toP, i.name), { overwrite: true });
		} catch (error) {
			console.warn(`can't cp ${fromP}/${i.name}`);
		}
	}
}
function getPkgUrls(data: PkgData) {
	return data.source.concat((data[`source_${thisArch}`] ?? []) as string[]);
}
function getPkgSums(data: PkgData) {
	const s = sumK.find((i) => Object.keys(data).find((x) => x.startsWith(i)));
	if (!s) return { type: "", sum: [] };
	const ss = `${s}sums` as const;
	const sum = (data[ss] as string[]) ?? [];
	const sum2 = (data[`${ss}_${thisArch}`] as string[]) ?? [];
	return {
		type: s,
		sum: sum.concat(sum2),
	};
}

function urlMapping(url: string, type: UrlX["type"]) {
	for (const i of urlMappingList) {
		if (i.type !== type) continue;
		let x: string | RegExp = "";
		if (i.regex) {
			x = new RegExp(i.src);
		} else {
			x = i.src;
		}
		if (
			(typeof x === "string" && url.includes(x)) ||
			(x instanceof RegExp && x.test(url))
		) {
			return url.replace(x, i.to);
		}
	}
	return url;
}

async function sumCheckStrict(path: string, type: string, sum: string) {
	if (sum === "SKIP") return false;
	if (sum === "") return false;
	if (!path) return false;
	try {
		const c = new Deno.Command(`${type}sum`, {
			args: [path],
			stdout: "piped",
		});
		const { stdout, success } = await c.output();
		if (!success) return false;
		const hash = new TextDecoder().decode(stdout).split(" ")[0];
		return hash === sum;
	} catch {
		return false;
	}
}

async function downloadAssets(
	urls: { name: string; url: string; sum: { type: string; value: string } }[],
	dir: string,
) {
	const counts = new Map<string, number>();

	for (const { name } of urls) {
		counts.set(name, (counts.get(name) || 0) + 1);
	}

	function deCount(name: string) {
		counts.set(name, (counts.get(name) || 0) - 1);
	}

	type I = {
		name: string;
		url: string;
		filename: string;
		fileUrl: string;
		type: UrlX["type"];
		path: string;
	}[];

	const httpL: I = [];
	const gitL: I = [];

	for (const { name, url, sum } of urls) {
		const { name: filename, url: fileUrl, type } = parseSourceUrl(url);

		if (!(fileUrl.startsWith("http://") || fileUrl.startsWith("https://"))) {
			deCount(name);
			continue;
		}
		const path = join(dir, name, filename);
		if (type === "git") {
			gitL.push({ name, url, filename, fileUrl, type, path });
		} else if (type === "http") {
			if (existsSync(path, { isFile: true })) {
				const x = await sumCheckStrict(path, sum.type, sum.value);
				if (x) {
					deCount(name);
					continue;
				}
			}
			httpL.push({ name, url, filename, fileUrl, type, path });
		}
	}

	const changeText = changeOut();

	function mprogress(ps: ReturnType<typeof progress>[]) {
		const all = urls.length;
		const run = all - counts.values().reduce((a, b) => a + b, 0);
		const msg = `${run}/${all}`;
		const w = Deno.consoleSize().columns - msg.length - 1;
		changeText.update(
			`${ps.map((i) => i.toString()).join("\n")}\n${p(Math.round((run / all) * w), w)} ${msg}`,
		);
	}

	function p(i: number, a: number) {
		return `[${"#".repeat(i)}${"-".repeat(a - i)}]`;
	}

	function progress(x: string) {
		let t = "";
		let _all = 0;
		return {
			update: (ic: number, iall?: number) => {
				const all = iall ?? _all;
				const c = Math.min(all, ic);
				const meg = `${(c / 1024 ** 2).toFixed(2)}MB/${(all / 1024 ** 2).toFixed(2)}MB ${x}`;
				const w = Deno.consoleSize().columns - meg.length - 1;
				const sw = all === 0 ? w : Math.round((c / all) * w);
				const s = `${p(sw, w)} ${meg}`;
				t = s;
				_all = all;
				mprogress(ps);
			},
			toString: () => t,
		};
	}

	let ps: ReturnType<typeof progress>[] = [];

	async function runConcurrentTasks(concurrency: number) {
		const workers = [];

		for (let i = 0; i < concurrency; i++) {
			workers.push(
				(async () => {
					while (httpL.length > 0) {
						await newDl();
					}
				})(),
			);
		}

		await Promise.all(workers);
	}

	async function newDl() {
		if (httpL.length === 0) {
			return;
		}
		const { fileUrl, filename, name, path } = httpL.pop()!;
		const nurl = urlMapping(fileUrl, "http");

		const shortFilename =
			filename.length > 10 ? `${filename.slice(0, 7)}...` : filename;
		const p = progress(
			`${Color.filePath(shortFilename)} ${Color.pkgName(name)}`,
		);
		p.update(0, 0);

		ps.push(p);

		try {
			await fetchFile(
				nurl,
				path,
				() => {},
				(l, a) => {
					p.update(l, a);
				},
			);
			deCount(name);
			p.update(Infinity);
			changeText.log(p.toString());
		} catch (error) {
			if (nurl !== fileUrl) {
				changeText.log(
					Color.warn(
						// @ts-ignore
						`can't fetching ${Color.pkgName(name)} ${Color.filePath(filename)} from ${Color.url(nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`)}:\n ${error.message}`,
					),
				);
				changeText.log(`Now try download from source url...`);
				try {
					await fetchFile(
						fileUrl,
						path,
						() => {},
						(l, a) => {
							p.update(l, a);
						},
					);
					deCount(name);
					p.update(Infinity);
					changeText.log(p.toString());
				} catch (error) {
					changeText.log(
						Color.error(
							// @ts-ignore
							`Error fetching ${Color.pkgName(name)} ${Color.filePath(filename)} from ${Color.url(fileUrl)}:\n ${error.message}`,
						),
					);
				}
			} else {
				changeText.log(
					Color.error(
						// @ts-ignore
						`can't fetching ${Color.pkgName(name)} ${Color.filePath(filename)} from ${Color.url(nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`)}:\n ${error.message}`,
					),
				);
			}
		} finally {
			ps = ps.filter((i) => i !== p);
			mprogress(ps);
		}
	}

	await runConcurrentTasks(downloadConcurrent);

	for (const { name, fileUrl, filename, path } of gitL) {
		const nurl = urlMapping(fileUrl, "git");
		try {
			await fetchGit(nurl, path, {
				simple: false,
				showOutput: true,
				srcUrl: fileUrl,
			});
			deCount(name);
		} catch (error) {
			xLog.error(
				// @ts-ignore
				`Error fetching ${Color.pkgName(name)} ${Color.filePath(filename)} from git ${Color.url(nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`)}:\n${error.message}`,
			);
		}
	}

	return Array.from(counts.entries())
		.filter(([, v]) => v === 0)
		.map(([k]) => k);
}

async function gpgCheckKeyInLocal(key: string) {
	const command = new Deno.Command("gpg", {
		args: ["--list-keys", "--fingerprint", key],
	});
	const { success } = await command.output();
	if (!success) return false;
	return true;
}

async function gpgImport(key: string) {
	const command = new Deno.Command("gpg", {
		args: ["--receive-keys", key],
	});
	const { success } = await command.output();
	if (!success) return false;
	return true;
}

async function checkPkgBuildDeps(names: string[]) {
	const l: string[] = [];
	for (const n of names) {
		const command = new Deno.Command("pacman", {
			args: ["-Q", n], // todo just single, some like sh show as bash
		});
		const { success } = await command.output();
		if (success) l.push(n);
	}
	return l;
}
async function checkPkgInOfficial(names: string[]) {
	const l: string[] = [];
	for (const n of names) {
		const command = new Deno.Command("pacman", {
			args: ["-Si", n], // todo just single, some like sh show as bash
		});
		const { success } = await command.output();
		if (success) l.push(n);
	}
	return l;
}

async function make(names: string[], data: Map<string, PkgData>) {
	const okNames: string[] = [];

	const buildList: string[] = [];

	const builtNames: string[] = [];
	for (const name of names) {
		const p = data.get(name)!;
		if (getPkgNames(p).every((i) => existsSync(join(buildPath, name, i)))) {
			builtNames.push(name);
			continue;
		}
	}
	const mustRebuild = builtNames.length
		? await checkbox({
				message: "Select packages to rebuild",
				choices: builtNames.map((i) => ({
					name: Color.pkgName(i),
					value: i,
					checked: true,
				})),
			})
		: [];
	for (const i of names) {
		if (mustRebuild.includes(i)) {
			buildList.push(i);
		} else if (builtNames.includes(i)) {
			okNames.push(i);
		} else {
			buildList.push(i);
		}
	}

	for (const [i, name] of buildList.entries()) {
		xLog.task(`Building ${name}...(${i + 1}/${buildList.length})`);
		const p = data.get(name)!;
		if (p.validpgpkeys) {
			const k: string[] = [];
			for (const i of p.validpgpkeys) {
				if (!(await gpgCheckKeyInLocal(i))) {
					k.push(i);
				}
			}
			if (k.length) {
				const x = await confirm({
					message: `The following keys are not trusted. Import them?\n${k.join("\n")}`,
				});
				if (x) {
					for (const i of k) {
						const x = await gpgImport(i);
						if (!x) console.error(`Import key ${i} failed.`);
					}
				}
			}
		}
		const x = new Deno.Command("makepkg", {
			args: ["-f"],
			cwd: join(buildPath, name),
			stdout: "inherit",
		}).spawn();
		await x.output();
		if ((await x.status).success) {
			okNames.push(name);
		}
	}
	return okNames;
}

async function installWithOutCheckDep(
	names: { name: string; version: string; official: boolean }[],
) {
	const of = names.filter((i) => i.official).map((i) => i.name);
	if (of.length) {
		const c = new Deno.Command("sudo", {
			args: ["pacman", "-S", "--noconfirm", ...of], // todo aur
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();
		await c.output();
	}

	const nl = names.map((i) => i.name);

	ensureDirSync(basePath);
	ensureDirSync(pkgbuildPath);
	ensureDirSync(buildPath);

	const x = changeOut();
	for (const [i, name] of nl.entries()) {
		x.update(`get ${Color.pkgName(name)}...(${i + 1}/${nl.length})`);
		const p = getPkgFile(name);
		if (p) {
			const data = parsePkgData(p);
			if (names.find((x) => x.name === name)?.version === getPkgVersion(data)) {
				continue;
			}
		}
		await getAurPackage(name, useGithub);
	}
	// todo view edit
	const parseData = new Map<string, PkgData>();
	const urls: {
		name: string;
		url: string;
		sum: { type: string; value: string };
	}[] = [];
	for (const name of nl) {
		parseData.set(name, parsePkgData(getPkgFile(name)!));
	}
	function getData(name: string): PkgData {
		const x = parseData.get(name);
		if (!x) throw `Cant find ${name}`;
		return x;
	}
	for (const name of nl) {
		cpMeta(name);
		const url = getPkgUrls(getData(name));
		const { type, sum } = getPkgSums(getData(name));
		for (const [n, i] of url.entries())
			urls.push({ name, url: i, sum: { type, value: sum[n] ?? "" } });
	}
	const sl = await downloadAssets(urls, buildPath);
	const sl2 = await make(sl, parseData);

	xLog.task("install");

	const pkgFiles: string[] = [];
	for (const i of sl2) {
		const data = getData(i);
		for (const x of getPkgNames(data)) {
			pkgFiles.push(join(buildPath, i, x));
		}
	}

	if (pkgFiles.length) {
		const c = new Deno.Command("sudo", {
			args: ["pacman", "-U", "--noconfirm", ...pkgFiles],
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();
		const { success } = await c.output();
		if (!success) {
			xLog.error(
				`Some packages failed to install.\n${sl2.map(Color.pkgName).join(" ")}`,
			);
		}
	}

	if (sl2.length !== nl.length)
		xLog.warn(
			`Some packages failed to build.\n${nl
				.filter((x) => !sl2.includes(x))
				.map(Color.pkgName)
				.join(", ")}`,
		);
}

async function update() {
	const x = new Deno.Command("sudo", {
		args: ["pacman", "-Syu"],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).spawn();
	await x.output();

	xLog.task("checking for updates...");

	const l = await getNewPackages();

	// todo get dkg diff like out of date

	const _nl = await checkbox({
		message: "Select packages to update",
		choices: l.map((p) => ({
			name: `${Color.pkgName(p.local.name)} ${Color.pkgVer(p.local.version)} -> ${Color.pkgVer(p.remote.Version)}`, // todo diff
			value: p,
		})),
	});

	const ps = new Set<string>();

	for (const {
		remote: { PackageBase },
	} of _nl) {
		ps.add(PackageBase);
	}

	const depMap = new Map<string, Set<string>>();
	function addDep(name: string, dep: string) {
		const l = depMap.get(dep) ?? new Set();
		l.add(name);
		depMap.set(dep, l);
	}
	for (const {
		local: { name },
		remote: { MakeDepends, Depends },
	} of _nl) {
		for (const i of MakeDepends ?? []) {
			addDep(name, i);
		}
		for (const i of Depends ?? []) {
			addDep(name, i);
		}
	}
	const hadInstalled = await checkPkgBuildDeps(Array.from(depMap.keys())); // todo with version check aur update
	const needInstall = Array.from(depMap.keys()).filter(
		(i) => !hadInstalled.includes(i),
	);
	const inOfficial = await checkPkgInOfficial(needInstall);
	if (needInstall.length) {
		console.log(
			"need install deps:",
			needInstall
				.map(
					(i) =>
						`${Color.pkgName(i)}${inOfficial.includes(i) ? "" : " (AUR)"} (${Array.from(depMap.get(i)!).map(Color.pkgName).join(" ")})`,
				)
				.join(", "),
		);
		const installDep = await confirm({
			message: `Install?`,
		});
		if (!installDep) return;
		await installWithOutCheckDep(
			needInstall.map((i) => ({
				name: i,
				version:
					l.find((x) => x.remote.PackageBase === i)?.remote.Version ?? "",
				official: inOfficial.includes(i),
			})),
		);
	}

	const nl = Array.from(ps);

	await installWithOutCheckDep(
		nl.map((i) => ({
			name: i,
			version: l.find((x) => x.remote.PackageBase === i)?.remote.Version ?? "",
			official: false,
		})),
	);
}

async function justDownloadAssets(dir: string) {
	const file = Deno.readTextFileSync(join(dir, ".SRCINFO"));
	const urls: {
		name: string;
		url: string;
		sum: { type: string; value: string };
	}[] = [];

	const data = parsePkgData(file);
	const name = data.keyName;
	const url = getPkgUrls(data);
	const { type, sum } = getPkgSums(data);
	for (const [n, i] of url.entries())
		urls.push({ name, url: i, sum: { type, value: sum[n] ?? "" } });
	await downloadAssets(urls, join(dir, ".."));
}

function isPacmanArgsEq(args1: string, args2: string) {
	return args1.split("").sort().join("") === args2.split("").sort().join("");
}

async function install(names: string[]) {
	const pkg: { name: string; desc?: string; isOffical: boolean }[] = [];
	const notFound: string[] = [];
	for (const name of names) {
		const command = new Deno.Command("pacman", {
			args: ["-Si", name],
			stdout: "null",
			stderr: "null",
		});
		const { success } = await command.output();
		if (success) {
			pkg.push({ name, isOffical: true });
		} else {
			notFound.push(name);
		}
	}

	if (notFound.length) {
		for (const name of notFound) {
			const url = new URL(aurUrl);
			url.searchParams.set("type", "search");
			url.searchParams.set("arg", name);
			const res = await fetch(url.toString());
			const data = (await res.json()) as AURSearchResponse;
			if (data.type === "search" && data.resultcount > 0) {
				pkg.push(
					...data.results.map((pkg) => ({
						name: pkg.Name,
						desc: pkg.Description,
						isOffical: false,
					})),
				);
			}
		}
	}

	let selectedPkg: (typeof pkg)[0] | null = null;
	if (pkg.length) {
		selectedPkg = await select({
			message: "选择要安装的包:",
			choices: pkg.map((i) => ({
				name: `${Color.pkgName(i.name)}${i.isOffical ? "" : " (AUR)"} ${i.desc}`,
				value: i,
			})),
		});
	} else {
		console.log("No packages found.");
		return;
	}

	if (selectedPkg.isOffical) {
		const c = new Deno.Command("sudo", {
			args: ["pacman", "-S", "--noconfirm", selectedPkg.name],
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();
		await c.output();
		return;
	}

	const aurPkg = await getAurInfo([selectedPkg.name], useGithubIndex);

	const depMap = new Map<string, Set<string>>();
	function addDep(name: string, dep: string) {
		const l = depMap.get(dep) ?? new Set();
		l.add(name);
		depMap.set(dep, l);
	}
	for (const {
		local: { name },
		remote: { MakeDepends, Depends },
	} of aurPkg.results.map((remote) => ({
		local: { name: remote.Name },
		remote: {
			MakeDepends: remote.MakeDepends,
			Depends: remote.Depends,
		},
	}))) {
		for (const i of MakeDepends ?? []) {
			addDep(name, i);
		}
		for (const i of Depends ?? []) {
			addDep(name, i);
		}
	}
	const hadInstalled = await checkPkgBuildDeps(Array.from(depMap.keys())); // todo with version check aur update
	const needInstall = Array.from(depMap.keys()).filter(
		(i) => !hadInstalled.includes(i),
	);
	const inOfficial = await checkPkgInOfficial(needInstall);
	if (needInstall.length) {
		console.log(
			"need install deps:",
			needInstall
				.map(
					(i) =>
						`${Color.pkgName(i)}${inOfficial.includes(i) ? "" : " (AUR)"} (${Array.from(depMap.get(i)!).map(Color.pkgName).join(" ")})`,
				)
				.join(", "),
		);
		const installDep = await confirm({
			message: `Install?`,
		});
		if (!installDep) return;
		await installWithOutCheckDep(
			needInstall.map((i) => ({
				name: i,
				version:
					aurPkg.results.find((i) => i.PackageBase === selectedPkg.name)
						?.Version ?? "",
				official: inOfficial.includes(i),
			})),
		);
	}

	await installWithOutCheckDep([
		{
			name: selectedPkg.name,
			version:
				aurPkg.results.find((i) => i.PackageBase === selectedPkg.name)
					?.Version ?? "",
			official: false,
		},
	]);
}

async function run() {
	const args = Deno.args;
	const mainArg = args.filter((i) => i.match(/^-[A-Z]/))[0]?.slice(1);
	const softwareNames = args.filter((i) => !i.startsWith("-"));
	const otherArgs = args.filter((i) => i.startsWith("--"));
	if (mainArg === undefined) {
		update();
	} else if (
		isPacmanArgsEq(mainArg, "Syu") ||
		isPacmanArgsEq(mainArg, "Syyu")
	) {
		update();
	} else if (isPacmanArgsEq(mainArg, "S")) {
		// 实现 install 功能
		await install(softwareNames);
	} else {
		// todo sudo check
		const proc = new Deno.Command("sudo", {
			args: ["pacman", `-${mainArg}`].concat(softwareNames, otherArgs),
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();
		await proc.output();
	}
}

run();
