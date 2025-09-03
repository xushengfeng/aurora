import { checkbox, confirm } from "@inquirer/prompts";
import { progress } from "@ryweal/progress";
import { copySync, ensureDirSync } from "@std/fs";

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

const aurUrl = "https://aur.archlinux.org/rpc/?v=5";
const aurPackageUrl = "https://aur.archlinux.org/$pkgname.git";
const aurPackageUrlKey = "$pkgname";
const basePath = `${Deno.env.get("XDG_CACHE_HOME") ?? Deno.env.get("HOME")}/.cache/myaur`;
const pkgbuildPath = `${basePath}/pkgbuild`;
const buildPath = `${basePath}/build`;

const thisArch = "x86_64";

const urlMappingList: {
	src: string;
	type: "git" | "http";
	regex?: true;
	to: string;
}[] = [
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
];

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

async function getAurInfo(names: string[]) {
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
	const aurPackages = await getAurInfo(localPackages.map((p) => p.name));
	const newPackages = aurPackages.results.flatMap((p) => {
		const local = localPackages.find((lp) => lp.name === p.Name);
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

	try {
		if (await exists(path)) {
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
				await setUrl(srcUrl);
				if (stderr.length > 0) {
					Deno.removeSync(path, { recursive: true });
				} else return true;
			}
		}

		// 执行 git clone 命令
		const command = new Deno.Command("git", {
			args: ["clone", url, path].concat(simple ? ["--depth", "1"] : []),
			stderr: "piped",
		});

		const { code, stderr } = await command.output();
		await setUrl(srcUrl);

		if (stderr.length > 0) {
			console.error(new TextDecoder().decode(stderr));
		}

		if (code !== 0) {
			throw new Error(`Git clone failed with exit code: ${code}`);
		}
		return true;
	} catch (error) {
		// @ts-expect-error
		console.error(`克隆仓库失败: ${error.message}`);
		return false;
	}
}

async function getAurPackage(name: string) {
	const url = aurPackageUrl.replace(aurPackageUrlKey, name);
	await fetchGit(url, `${pkgbuildPath}/${name}`);
}

function parsePkgData(data: string) {
	const pkgbuild: {
		pkgname: string;
		pkgver: string;
		pkgrel: string;
		source: string[];
		source_x86_64?: string[];
	} & Record<string, string | string[]> = {
		pkgname: "",
		pkgver: "",
		pkgrel: "",
		source: [],
	};
	for (const i of data.split("\n")) {
		const eq = i.indexOf("=");
		if (eq === -1) continue;
		const key = i.slice(0, eq).trim();
		const value = i.slice(eq + 1).trim();
		if (key && value) {
			const old = pkgbuild[key];
			if (Array.isArray(old)) {
				old.push(value);
			} else if (old) {
				pkgbuild[key] = [old, value];
			} else {
				pkgbuild[key] = value;
			}
		}
	}
	return pkgbuild;
}

function getPkgFile(name: string) {
	const p = `${pkgbuildPath}/${name}/.SRCINFO`;
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
				.replace(/\.git.*$/, "");
		} else {
			name = url.split("/").at(-1)!;
		}
	} else {
		u = url.slice(x + 2);
		name = url.slice(0, x);
	}

	if (u.startsWith("git+")) {
		u = u.slice(4).replace(/\.git.*$/, "");
		type = "git";
	}

	return {
		name,
		url: u,
		type,
	};
}

function cpMeta(name: string) {
	const fromP = `${pkgbuildPath}/${name}`;
	const toP = `${buildPath}/${name}/`;
	ensureDirSync(toP);
	for (const i of Deno.readDirSync(fromP)) {
		if (i.name === ".git") continue;
		copySync(`${fromP}/${i.name}`, `${toP}/${i.name}`, { overwrite: true });
	}
}
async function parsePkgUrls(name: string) {
	const fromP = `${pkgbuildPath}/${name}`;
	const toP = `${buildPath}/${name}/`;
	const p = `${pkgbuildPath}/${name}/.SRCINFO`;
	const data = parsePkgData(Deno.readTextFileSync(p));
	for (const i of Deno.readDirSync(fromP)) {
		if (i.name === ".git") continue;
		await new Deno.Command("cp", {
			args: [`${fromP}/${i.name}`, toP, "-r"],
		}).output();
	}
	return data.source.concat((data[`source_${thisArch}`] ?? []) as string[]);
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

async function downloadAssets(urls: { name: string; url: string }[]) {
	const counts = new Map<string, number>();

	for (const { name } of urls) {
		counts.set(name, (counts.get(name) || 0) + 1);
	}

	function deCount(name: string) {
		counts.set(name, (counts.get(name) || 0) - 1);
	}

	for (const { name, url } of urls) {
		const { name: filename, url: fileUrl, type } = parseSourceUrl(url);

		if (!(fileUrl.startsWith("http://") || fileUrl.startsWith("https://"))) {
			deCount(name);
			continue;
		}
		const path = `${buildPath}/${name}/${filename}`;

		if (type === "git") {
			const nurl = urlMapping(fileUrl, "git");
			console.log(
				`${name} ${filename} from git ${nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`}`,
			);
			try {
				await fetchGit(nurl, path, {
					simple: false,
					showOutput: true,
					srcUrl: fileUrl,
				});
				deCount(name);
			} catch (error) {
				console.error(`Error fetching ${nurl}:`, error);
			}
		} else if (type === "http") {
			if (existsSync(path, { isFile: true })) {
				// todo sum check
				const x = await confirm({
					message: `File ${name}/${filename} already exists. Overwrite?`,
				});
				if (!x) {
					deCount(name);
					continue;
				}
			}

			const nurl = urlMapping(fileUrl, "http");

			console.log(
				`${name} ${filename} from ${nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`}`,
			);

			let p: ReturnType<typeof progress> | null = null;

			try {
				await fetchFile(
					nurl,
					path,
					(all) => {
						p = progress(
							`Downloading ${name} ${filename} [[bar]] [[count]]/[[total]] [[rate]] [[eta]]\n`,
							{
								total: all,
								unit: "MB",
								unitScale: 1024 * 1024,
								shape: {
									bar: {
										start: "|",
										end: "|",
										completed: "█",
										pending: " ",
									},
									total: { mask: "###.##" },
									count: { mask: "###.##" },
								},
							},
						);
					},
					(l) => {
						p?.update(l);
					},
				); // todo multi
				deCount(name);
			} catch (error) {
				console.error(`Error fetching ${nurl}:`, error);
			}
		}
	}

	return Array.from(counts.entries())
		.filter(([, v]) => v === 0)
		.map(([k]) => k);
}

async function make(names: string[]) {
	const okNames: string[] = [];
	for (const name of names) {
		console.log(`Building ${name}...`);
		const x = new Deno.Command("makepkg", {
			args: ["-f"],
			cwd: `${buildPath}/${name}`,
			stdout: "inherit",
		}).spawn();
		await x.output();
		if ((await x.status).success) {
			okNames.push(name);
		}
	}
	return okNames;
}

async function update() {
	console.log("checking for updates...");

	const l = await getNewPackages();
	const nl = await checkbox({
		message: "Select packages to update",
		choices: l.map((p) => ({
			name: `${p.local.name} ${p.local.version} -> ${p.remote.Version}`,
			value: p.remote.Name,
		})),
	});

	ensureDirSync(basePath);
	ensureDirSync(pkgbuildPath);
	ensureDirSync(buildPath);

	for (const [i, name] of nl.entries()) {
		console.log(`get ${name}...(${i + 1}/${nl.length})`);
		const p = getPkgFile(name);
		if (p) {
			console.log("find", name);
			const data = parsePkgData(p);
			// todo cache
			if (
				l.find((x) => x.remote.Name === name)?.remote.Version ===
				`${data.pkgver}-${data.pkgrel}`
			) {
				console.log(`${name} PKGBUILD is downloaded.`);
				continue;
			}
		}
		await getAurPackage(name);
	}
	// todo view edit
	const urls: { name: string; url: string }[] = [];
	for (const name of nl) {
		cpMeta(name);
		const url = await parsePkgUrls(name);
		console.log(`found ${url.length} assets for ${name}`);
		for (const i of url) urls.push({ name, url: i });
	}
	const sl = await downloadAssets(urls);
	const sl2 = await make(sl);

	console.log("install");

	const pkgFiles: string[] = [];
	for (const i of sl2) {
		const p = getPkgFile(i);
		if (!p) continue;
		const data = parsePkgData(p);
		const x = `${data.pkgname}-${data.pkgver}-${data.pkgrel}-${thisArch}.pkg.tar.zst`;
		pkgFiles.push(`${buildPath}/${i}/${x}`);
	}

	if (pkgFiles.length)
		new Deno.Command("sudo", {
			args: ["pacman", "-U", ...pkgFiles],
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();

	if (sl2.length !== nl.length)
		console.log(
			"Some packages failed to build.",
			nl.filter((x) => !sl2.includes(x)),
		);
}

update();
