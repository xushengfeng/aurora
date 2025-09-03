import { checkbox, confirm } from "@inquirer/prompts";
import { progress } from "@ryweal/progress";

export { parsePKGBUILD, parsePKGBUILDMore };

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

// 类型定义
interface ParamExpansionMatch {
	fullMatch: string;
	expression: string;
	isSimple: boolean;
}

// 解析复杂参数表达式
interface ParsedExpression {
	variable: string;
	operator?: string;
	pattern?: string;
	replacement?: string;
	defaultValue?: string;
}

const aurUrl = "https://aur.archlinux.org/rpc/?v=5";
const aurPackageUrl = "https://aur.archlinux.org/$pkgname.git";
const aurPackageUrlKey = "$pkgname";
const basePath = `${Deno.env.get("XDG_CACHE_HOME") ?? Deno.env.get("HOME")}/.cache/myaur`;
const pkgbuildPath = `${basePath}/pkgbuild`;
const buildPath = `${basePath}/build`;

// 完整的参数扩展正则表达式
const PARAM_EXPANSION_REGEX = /\$(?:\{([^}]+)\}|(\w+))/g;

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
];

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
	const res = await fetch(url);

	if (!res.ok) {
		throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
	}

	// 获取内容长度（可能为null）
	const contentLength = res.headers.get("content-length");
	const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
	if (onStart) onStart(totalBytes);
	if (!res.body) {
		throw new Error("Response body is null");
	}

	const reader = res.body.getReader();
	let receivedBytes = 0;
	const chunks: Uint8Array[] = [];

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			chunks.push(value);
			receivedBytes += value.length;

			// 调用进度回调
			if (onProgress) {
				onProgress(receivedBytes, totalBytes);
			}
		}
	} finally {
		reader.releaseLock();
	}

	// 合并所有块并写入文件
	const fullData = new Uint8Array(receivedBytes);
	let position = 0;

	for (const chunk of chunks) {
		fullData.set(chunk, position);
		position += chunk.length;
	}

	await Deno.writeFile(path, fullData);

	// 最终进度回调（确保达到100%）
	if (onProgress && totalBytes !== null) {
		onProgress(totalBytes, totalBytes);
	}
}

async function fetchGit(url: string, path: string): Promise<boolean> {
	try {
		// 检查目标路径是否已存在
		try {
			const stat = await Deno.stat(path);
			if (stat.isDirectory) {
				// todo pull
				return true;
			}
		} catch (error) {
			// 目录不存在，继续执行
			if (!(error instanceof Deno.errors.NotFound)) {
				throw error;
			}
		}

		// 执行 git clone 命令
		const command = new Deno.Command("git", {
			args: ["clone", "--depth", "1", url, path],
		});

		const { code, stderr } = await command.output();

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

function parsePKGBUILD(data: string) {
	// todo .SRCINFO
	const pkgbuild: Record<string, string> = {};
	let runtype: "normal" | "ignoreLine" = "normal";
	let isLineStart = true;
	let l = "";
	let key = "";
	let afterEq = false;
	let valueStart = false;
	let endC = "\n";

	for (let i = 0; i < data.length; i++) {
		const char = data[i];
		if (isLineStart) {
			isLineStart = false;
			if (char === "\n") {
				isLineStart = true;
				continue;
			}
			if (!/[a-z_-]/.test(char)) {
				// todo more
				runtype = "ignoreLine";
				continue;
			}
		}
		if (runtype === "normal") {
			if (char === "=") {
				key = l;
				l = "";
				afterEq = true;
			} else {
				if (afterEq && !valueStart && /\S/.test(char)) {
					valueStart = true;
					l = "";
				}
				if (char === "(" && valueStart) endC = ")";
				l += char;
				afterEq = false;
				valueStart = false;
			}
		}
		if (runtype === "ignoreLine") {
			if (char === "\n") {
				isLineStart = true;
				runtype = "normal";
			}
			continue;
		}
		if (char === endC) {
			if (key) {
				pkgbuild[key] = l.trim();
				key = "";
			}
			l = "";
			endC = "\n";
			if (char === "\n") {
				isLineStart = true;
				runtype = "normal";
			}
		}
	}
	return pkgbuild;
}

// 解析所有参数扩展
function parseAllParamExpansions(str: string): ParamExpansionMatch[] {
	const matches: ParamExpansionMatch[] = [];
	const regex = new RegExp(PARAM_EXPANSION_REGEX);
	let match = regex.exec(str);

	while (match !== null) {
		const isSimple = !!match[2]; // 如果是简单格式 $var
		const expression = isSimple ? match[2] : match[1];

		matches.push({
			fullMatch: match[0],
			expression,
			isSimple,
		});

		match = regex.exec(str);
	}

	return matches;
}

function parseComplexExpression(expr: string): ParsedExpression {
	// 匹配操作符: %, %%, #, ##, /, //, :, :-, :=, :?, :+
	const operatorRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:([%#/:]+)([^}]*))?$/;
	const match = expr.match(operatorRegex);

	if (!match) {
		return { variable: expr };
	}

	const variable = match[1];
	const operator = match[2] || "";
	const rest = match[3] || "";

	let pattern: string | undefined;
	let replacement: string | undefined;
	let defaultValue: string | undefined;

	// 根据操作符类型解析剩余部分
	if (operator === "/" || operator === "//") {
		// 替换操作: ${var/pattern/replacement}
		const parts = rest.split("/");
		if (parts.length >= 2) {
			pattern = parts[0];
			replacement = parts[1];
		}
	} else if (operator === ":" && rest.length > 0) {
		// 默认值操作: ${var:-default}, ${var:=default}, ${var:?error}, ${var:+alternative}
		const subOperator = rest[0];
		defaultValue = rest.substring(1);

		// 处理特殊操作符
		if (
			subOperator === "-" ||
			subOperator === "=" ||
			subOperator === "?" ||
			subOperator === "+"
		) {
			return {
				variable,
				operator: operator + subOperator,
				defaultValue,
			};
		}
	} else if (operator && rest) {
		// 其他操作符: %, %%, #, ##
		pattern = rest;
	}

	return {
		variable,
		operator,
		pattern,
		replacement,
		defaultValue,
	};
}

// 应用参数扩展
function applyParamExpansion(
	str: string,
	variables: Record<string, string>,
): string {
	const matches = parseAllParamExpansions(str);
	let result = str;

	for (const match of matches) {
		if (match.isSimple) {
			// 简单变量: $var
			if (match.expression in variables) {
				result = result.replace(match.fullMatch, variables[match.expression]);
			}
		} else {
			// 复杂表达式: ${expression}
			const parsed = parseComplexExpression(match.expression);

			if (!(parsed.variable in variables)) {
				// 变量不存在，处理默认值等情况
				if (parsed.operator === ":-" || parsed.operator === ":=") {
					result = result.replace(match.fullMatch, parsed.defaultValue || "");
				} else if (parsed.operator === ":?") {
					throw new Error(
						`Parameter expansion error: ${parsed.variable}${parsed.operator}${parsed.defaultValue}`,
					);
				} else if (parsed.operator === ":+") {
					result = result.replace(match.fullMatch, "");
				}
				continue;
			}

			let value = variables[parsed.variable];

			// 应用参数扩展操作
			switch (parsed.operator) {
				case "%": // 从末尾移除最短匹配
					if (parsed.pattern && value.endsWith(parsed.pattern)) {
						value = value.slice(0, -parsed.pattern.length);
					}
					break;
				case "%%": // 从末尾移除最长匹配
					if (parsed.pattern) {
						while (value.endsWith(parsed.pattern)) {
							value = value.slice(0, -parsed.pattern.length);
						}
					}
					break;
				case "#": // 从开头移除最短匹配
					if (parsed.pattern && value.startsWith(parsed.pattern)) {
						value = value.slice(parsed.pattern.length);
					}
					break;
				case "##": // 从开头移除最长匹配
					if (parsed.pattern) {
						while (value.startsWith(parsed.pattern)) {
							value = value.slice(parsed.pattern.length);
						}
					}
					break;
				case "/": // 替换第一次出现
					if (parsed.pattern && parsed.replacement !== undefined) {
						value = value.replace(parsed.pattern, parsed.replacement);
					}
					break;
				case "//": // 替换所有出现
					if (parsed.pattern && parsed.replacement !== undefined) {
						value = value.replace(
							new RegExp(parsed.pattern, "g"),
							parsed.replacement,
						);
					}
					break;
				case ":-": // 使用默认值（如果变量未设置或为空）
					if (!value) {
						value = parsed.defaultValue || "";
					}
					break;
				case ":=": // 分配默认值（如果变量未设置或为空）
					if (!value) {
						value = parsed.defaultValue || "";
						variables[parsed.variable] = value; // 更新变量值
					}
					break;
				case ":?": // 显示错误（如果变量未设置或为空）
					if (!value) {
						throw new Error(
							`Parameter expansion error: ${parsed.variable}${parsed.operator}${parsed.defaultValue}`,
						);
					}
					break;
				case ":+": // 使用替代值（如果变量已设置且非空）
					if (value) {
						value = parsed.defaultValue || "";
					} else {
						value = "";
					}
					break;
				// 子字符串提取 ${var:offset:length}
				default:
					if (
						parsed.operator?.startsWith(":") &&
						parsed.operator.length === 1
					) {
						const parts = parsed.pattern?.split(":") || [];
						const offset = parseInt(parts[0] || "0", 10);
						const length = parts[1] ? parseInt(parts[1], 10) : undefined;

						if (length !== undefined) {
							value = value.substring(offset, offset + length);
						} else {
							value = value.substring(offset);
						}
					}
					break;
			}

			result = result.replace(match.fullMatch, value);
		}
	}

	return result;
}

function parsePKGBUILDMore(data: Record<string, string>) {
	function unwarpStr(str: string) {
		let s = str;
		if (str.startsWith('"') && str.endsWith('"')) s = str.slice(1, -1);
		if (str.startsWith("'") && str.endsWith("'")) s = str.slice(1, -1);
		// @ts-expect-error
		s = applyParamExpansion(s, res);
		return s;
	}
	function unwarpArray(str: string) {
		const arr: string[] = [];
		const inner = str.slice(1, -1).trim();
		let s = inner;
		let count = 0;
		while (s.length && count < inner.length) {
			let c: number = 0;
			if (s.startsWith('"')) {
				c = s.indexOf('"', 1);
			} else if (s.startsWith("'")) c = s.indexOf("'", 1);
			else {
				const i = s.search(/\s/);
				if (i === -1) c = s.length - 1;
				else c = i - 1;
			}
			if (c !== 0) {
				const end = c;
				const v = s.slice(0, end + 1);
				const other = s.slice(end + 1).trimStart();
				arr.push(unwarpStr(v));
				s = other;
			}
			count++;
		}
		return arr;
	}
	const res: {
		pkgname: string;
		pkgver: string;
		source: string[];
		source_x86_64?: string[];
	} & Record<string, string | string[]> = {
		pkgname: "",
		pkgver: "",
		source: [],
	};
	for (const [k, v] of Object.entries(data)) {
		if (v.startsWith("(") && v.endsWith(")")) {
			res[k] = unwarpArray(v);
		} else if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		) {
			res[k] = unwarpStr(v);
		} else {
			res[k] = v;
		}
	}
	return res;
}

function getPkgFile(name: string) {
	const p = `${pkgbuildPath}/${name}/PKGBUILD`;
	try {
		const fileInfo = Deno.statSync(p);
		if (!fileInfo.isFile) return null;
	} catch {
		return null;
	}
	try {
		return Deno.readTextFileSync(p);
	} catch (error) {
		console.error(`Error reading ${p}:`, error);
	}
	return null;
}

function parseSourceUrl(url: string) {
	const x = url.indexOf("::");
	let name = "";
	let u = "";

	if (x === -1) {
		u = url;
		name = url.split("/").at(-1)!;
	} else {
		u = url.slice(x + 2);
		name = url.slice(0, x);
	}

	return {
		name,
		url: u,
	};
}

async function pkgAssetsUrls(name: string) {
	const fromP = `${pkgbuildPath}/${name}`;
	const toP = `${buildPath}/${name}/`;
	const p = `${pkgbuildPath}/${name}/PKGBUILD`;
	const data = parsePKGBUILDMore(parsePKGBUILD(Deno.readTextFileSync(p)));
	for (const i of Deno.readDirSync(fromP)) {
		if (i.name === ".git") continue;
		await new Deno.Command("cp", {
			args: [`${fromP}/${i.name}`, toP, "-r"],
		}).output();
	}
	return data.source.concat((data[`source_${thisArch}`] ?? []) as string[]);
}

function urlMapping(url: string, type: "git" | "http") {
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
	for (const { name, url } of urls) {
		const { name: filename, url: fileUrl } = parseSourceUrl(url);

		if (!(fileUrl.startsWith("http://") || fileUrl.startsWith("https://"))) {
			continue;
		}

		const path = `${buildPath}/${name}/${filename}`;
		try {
			if (Deno.statSync(path)) {
				// todo sum check
				const x = await confirm({
					message: `File ${name}/${filename} already exists. Overwrite?`,
				});
				if (!x) continue;
			}
		} catch (error) {}

		const nurl = urlMapping(fileUrl, "http");

		console.log(
			`${name} ${filename} from ${nurl === fileUrl ? fileUrl : `${fileUrl} -> ${nurl}`}`,
		);

		let p: ReturnType<typeof progress> | null = null;

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
	}
}

async function make(names: string[]) {
	for (const name of names) {
		console.log(`Building ${name}...`);
		const x = new Deno.Command("makepkg", {
			args: ["-f"],
			cwd: `${buildPath}/${name}`,
			stdout: "inherit",
		}).spawn();
		await x.output();
	}
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

	try {
		Deno.mkdirSync(basePath, { recursive: true });
	} catch (error) {}
	try {
		Deno.mkdirSync(pkgbuildPath, { recursive: true });
	} catch (error) {}
	try {
		Deno.mkdirSync(buildPath, { recursive: true });
	} catch (error) {}

	for (const [i, name] of nl.entries()) {
		console.log(`get ${name}...(${i + 1}/${nl.length})`);
		const p = getPkgFile(name);
		if (p) {
			console.log("find", name);
			const data = parsePKGBUILDMore(parsePKGBUILD(p));
			if (
				l.find((x) => x.remote.Name === name)?.remote.Version === data.pkgver
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
		const url = await pkgAssetsUrls(name);
		console.log(`found ${url.length} assets for ${name}`);
		for (const i of url) urls.push({ name, url: i });
	}
	await downloadAssets(urls);
	await make(nl);

	console.log("install");

	const pkgFiles: string[] = [];
	for (const i of nl) {
		const p = getPkgFile(i);
		if (!p) continue;
		const data = parsePKGBUILDMore(parsePKGBUILD(p));
		const x = `${data.pkgname}-${data.pkgver}-${data.pkgrel}-${thisArch}.pkg.tar.zst`;
		pkgFiles.push(`${buildPath}/${i}/${x}`);
	}
	console.log(`sudo pacman -U ${pkgFiles.join(" ")}`);

	new Deno.Command("sudo", {
		args: ["pacman", "-U", ...pkgFiles],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}).spawn();
}

update();
