import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import z from "@deepseek-ai/schemastery";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { parse } from "yaml";
import { isSkillName } from "@deepseek-ai/dsh-skill";
//#region src/git.ts
/**
* Thin git command helpers for the skills sync surface: clone, pull, and
* commit/push run through the `git` binary so the local skills checkout stays
* a real repository. The GitLab token is embedded in the checkout's origin URL
* so every later `pull`/`push` authenticates without a credential helper; the
* checkout lives under the user's DSH home (like the settings token) and is
* never committed or shared, so this is the same exposure class as the token
* already stored in `settings.yaml`.
* @module @lim324/dsh-gitlab/src/git
*/
const execFileAsync$1 = promisify(execFile);
/** Test hook: tests substitute a fake git runner; production never touches this. */
const internals$1 = {};
/** Process env + spawn options that make git fail fast instead of prompting. */
const gitRunOptions = {
	env: {
		...process.env,
		GIT_TERMINAL_PROMPT: "0"
	},
	stdio: [
		"ignore",
		"pipe",
		"pipe"
	]
};
async function runGit(args) {
	if (internals$1.runGit !== void 0) return await internals$1.runGit(args, gitRunOptions);
	const { stdout } = await execFileAsync$1("git", args, gitRunOptions);
	return stdout;
}
/** Inject an oauth2 token into an https clone URL. */
function authedUrl(url, token) {
	if (token === void 0 || token === "") return url;
	const parsed = new URL(url);
	parsed.username = "oauth2";
	parsed.password = token;
	return parsed.toString().replace(/\/$/, "");
}
/**
* Clone one repository shallowly to `dest`, keeping the token in the origin
* URL so subsequent pulls and pushes authenticate.
* @param cloneUrl - https clone URL (token-free).
* @param token - optional GitLab token for private repositories.
* @param dest - destination directory.
*/
async function gitClone(cloneUrl, token, dest) {
	await runGit([
		"clone",
		"--depth",
		"1",
		authedUrl(cloneUrl, token),
		dest
	]);
}
/** Fast-forward pull one existing checkout to its remote default branch. */
async function gitPull(dest) {
	await runGit([
		"-C",
		dest,
		"pull",
		"--ff-only"
	]);
}
/**
* Stage all changes, commit, and push in one existing checkout.
* @param dest - the checkout directory.
* @param message - commit message.
*/
async function gitCommitPush(dest, message) {
	await runGit([
		"-C",
		dest,
		"add",
		"-A"
	]);
	await runGit([
		"-C",
		dest,
		"commit",
		"-m",
		message
	]);
	await runGit([
		"-C",
		dest,
		"push",
		"HEAD"
	]);
}
/** Read a checkout's origin URL (trimmed); throws when there is no origin. */
async function gitGetRemoteUrl(dest) {
	return (await runGit([
		"-C",
		dest,
		"remote",
		"get-url",
		"origin"
	])).trim();
}
/** Point a checkout's origin at `url`. */
async function gitSetRemoteUrl(dest, url) {
	await runGit([
		"-C",
		dest,
		"remote",
		"set-url",
		"origin",
		url
	]);
}
/**
* Re-embed `token` into a checkout's origin URL when the stored token differs,
* so a token rotation takes effect on existing checkouts without a re-clone.
* No-op when the token is unset, the checkout has no origin, or the token is
* unchanged.
* @param dest - the checkout directory.
* @param token - the current GitLab token.
*/
async function refreshOriginToken(dest, token) {
	if (token === void 0 || token === "") return;
	let current;
	try {
		current = await gitGetRemoteUrl(dest);
	} catch {
		return;
	}
	if (current === "") return;
	const desired = authedUrl(current, token);
	if (desired !== current) await gitSetRemoteUrl(dest, desired);
}
//#endregion
//#region src/gitlab.ts
/**
* Parse a git origin URL into host and project, for the three shapes git
* produces: `https://host/group/project.git`, `git@host:group/project.git`,
* and `ssh://git@host:port/group/project.git`. The host never carries the
* port: an ssh port is meaningless to the HTTPS API, and https remotes with
* explicit ports are rare enough to leave to `config.baseUrl`.
* @param url - the raw `git remote get-url origin` output.
* @returns the parsed remote, or undefined for non-origin shapes.
*/
function parseGitRemote(url) {
	let host;
	let rest;
	const https = /^https?:\/\/([^/]+)\/(.+)$/.exec(url.trim());
	if (https !== null) {
		host = https[1];
		rest = https[2];
	} else {
		const sshUrl = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url.trim());
		const scp = /^git@([^:]+):(.+)$/.exec(url.trim());
		const ssh = sshUrl ?? scp;
		if (ssh === null) return void 0;
		host = ssh[1];
		rest = ssh[2];
	}
	const project = rest.replace(/\.git$/, "");
	if (project === "" || project.split("/").some((segment) => segment === "" || segment === "..")) return void 0;
	return {
		host,
		project
	};
}
/**
* Thin GitLab REST v4 client over injectable fetch: bearer-style private
* token header, a per-request timeout, and typed projections for the four
* calls the UI surface needs.
*/
var GitlabApi = class {
	baseUrl;
	token;
	tokenProvider;
	fetchImpl;
	timeoutMs;
	constructor(options) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.token = options.token;
		this.tokenProvider = options.tokenProvider;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 15e3;
	}
	/** The token the next request will send: the live provider first, then the static option. */
	currentToken() {
		return this.tokenProvider?.() ?? this.token;
	}
	/** Whether a token is configured (write operations need one). */
	hasToken() {
		const token = this.currentToken();
		return token !== void 0 && token !== "";
	}
	async request(path, init = {}) {
		const headers = {
			accept: "application/json",
			...init.headers
		};
		const token = this.currentToken();
		if (token !== void 0) headers["private-token"] = token;
		if (init.body !== void 0 && headers["content-type"] === void 0) headers["content-type"] = "application/json";
		const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
			...init,
			headers,
			signal: AbortSignal.timeout(this.timeoutMs)
		});
		if (!res.ok) throw new Error(`GitLab API ${String(res.status)} for ${path}`);
		if (res.status === 204) return void 0;
		const text = await res.text();
		if (text === "") return void 0;
		return JSON.parse(text);
	}
	/** Latest pipelines, newest first, capped server-side. */
	async listPipelines(project, perPage = 5) {
		return (await this.request(`/projects/${encodeURIComponent(project)}/pipelines?${new URLSearchParams({ per_page: String(perPage) })}`)).map((item) => ({
			id: item.id,
			status: item.status,
			ref: item.ref,
			sha: item.sha,
			webUrl: item.web_url,
			commit: null,
			jobs: []
		}));
	}
	/** The jobs of one pipeline (stage order) plus the commit it ran for, which the jobs response carries. */
	async listPipelineJobs(project, pipelineId) {
		const sorted = [...await this.request(`/projects/${encodeURIComponent(project)}/pipelines/${String(pipelineId)}/jobs`)].sort((left, right) => left.id - right.id);
		const first = sorted[0];
		return {
			jobs: sorted.map((item) => ({
				id: item.id,
				name: item.name,
				stage: item.stage,
				status: item.status,
				durationSeconds: item.duration,
				webUrl: item.web_url
			})),
			commit: first?.commit == null ? null : {
				title: first.commit.title,
				authorName: first.commit.author_name
			}
		};
	}
	/** Open merge requests, newest first, capped server-side. */
	async listMrs(project, perPage = 10) {
		return (await this.request(`/projects/${encodeURIComponent(project)}/merge_requests?${new URLSearchParams({
			state: "opened",
			per_page: String(perPage)
		})}`)).map((item) => ({
			iid: item.iid,
			title: item.title,
			sourceBranch: item.source_branch,
			targetBranch: item.target_branch,
			author: item.author?.name ?? null,
			webUrl: item.web_url
		}));
	}
	/** The project's default branch, when the API reports one. */
	async getDefaultBranch(project) {
		return (await this.request(`/projects/${encodeURIComponent(project)}`)).default_branch;
	}
	/** The project's branch names, most recently active first, capped server-side. */
	async listBranches(project, perPage = 50) {
		return (await this.request(`/projects/${encodeURIComponent(project)}/repository/branches?${new URLSearchParams({ per_page: String(perPage) })}`)).map((item) => item.name);
	}
	/** List the projects of one group, optionally including nested subgroups. */
	async listGroupProjects(group, includeSubgroups = true, perPage = 100) {
		const params = new URLSearchParams({
			per_page: String(perPage),
			include_subgroups: String(includeSubgroups),
			simple: "true"
		});
		return (await this.request(`/groups/${encodeURIComponent(group)}/projects?${params.toString()}`)).map((item) => ({
			name: item.name,
			pathWithNamespace: item.path_with_namespace
		}));
	}
	/** Create one merge request; returns its iid and web link. */
	async createMr(project, input) {
		const data = await this.request(`/projects/${encodeURIComponent(project)}/merge_requests`, {
			method: "POST",
			body: JSON.stringify({
				source_branch: input.sourceBranch,
				target_branch: input.targetBranch,
				title: input.title
			})
		});
		return {
			iid: data.iid,
			webUrl: data.web_url
		};
	}
	/** Approve one MR. */
	async approveMr(project, iid) {
		await this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}/approve`, { method: "POST" });
	}
	/** Close one open MR without merging. */
	async closeMr(project, iid) {
		await this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}`, {
			method: "PUT",
			body: JSON.stringify({ state_event: "close" })
		});
	}
	/** Merge one MR. */
	async mergeMr(project, iid) {
		await this.request(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}/merge`, { method: "PUT" });
	}
};
//#endregion
//#region src/fence.ts
/** Whether a request reached us over a loopback authority with no cross-site markers. */
function isTrustedLocalRequest(req) {
	const host = req.headers.host;
	if (host === void 0) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	const hostname = hostUrl.hostname;
	if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/skill.ts
/**
* Local-checkout skill provider for the DeepSeek Harness skill seam. Each
* GitLab skill source is `git clone`d to a local directory; this provider
* scans that checkout for `SKILL.md` directory bundles and registers them on
* `ctx.skills`. Reads are local filesystem reads (fast, offline-capable) — the
* sync step (`git clone`/`git pull`) owns freshness, and writes (commit/push)
* belong to the separate management tools, not this read-only seam.
* @module @lim324/dsh-gitlab/src/skill
*/
const SKILL_FILE = "SKILL.md";
/**
* Extract the YAML frontmatter block from a skill file. Returns the parsed
* data map plus the remaining body, or undefined when the file has no
* frontmatter or the block is malformed.
*/
function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
	const closing = findClosingFrontmatter(raw, firstLineEnd + 1);
	if (closing === void 0) return void 0;
	let parsed;
	try {
		parsed = parse(raw.slice(firstLineEnd + 1, closing.start));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	return {
		data: parsed,
		body: raw.slice(closing.bodyStart)
	};
}
/** Find the closing `---` line after the frontmatter opener. */
function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") return {
			start: lineStart,
			bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1
		};
		if (nextNewline < 0) return void 0;
		lineStart = nextNewline + 1;
	}
}
/** Read a non-empty string frontmatter field. */
function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/** Normalize the two invocation switches, matching `dsh-skill-filesystem`. */
function parseInvocationPolicy(data) {
	const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
	const userInvocable = frontmatterBoolean(data, "user-invocable");
	return {
		modelInvocable: disableModelInvocation !== true,
		userInvocable: userInvocable !== false
	};
}
/** Parse a boolean frontmatter field accepting YAML and string spellings. */
function frontmatterBoolean(data, key) {
	if (!Object.hasOwn(data, key)) return void 0;
	const value = data[key];
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") switch (value.toLowerCase()) {
		case "true":
		case "yes":
		case "on": return true;
		case "false":
		case "no":
		case "off": return false;
	}
	throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}
/**
* Parse one skill file into its normalized fields, returning undefined for a
* file missing required frontmatter or carrying an invalid name or policy.
*/
function parseSkill(raw, ctx) {
	const parsed = parseFrontmatter(raw);
	if (parsed === void 0) return void 0;
	const name = stringField(parsed.data, "name");
	const description = stringField(parsed.data, "description");
	if (name === void 0 || description === void 0) return void 0;
	if (!isSkillName(name)) return void 0;
	let invocation;
	try {
		invocation = parseInvocationPolicy(parsed.data);
	} catch (error) {
		ctx.logger.warn(`gitlab skill "${name}" ignored: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const whenToUse = stringField(parsed.data, "whenToUse");
	return {
		name,
		description,
		...whenToUse === void 0 ? {} : { whenToUse },
		invocation,
		content: parsed.body.trim()
	};
}
/** Recursively collect every `SKILL.md` path under a directory. */
async function findSkillFiles(root) {
	const found = [];
	const walk = async (dir) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name === SKILL_FILE) found.push(full);
		}
	};
	await walk(root);
	return found;
}
/**
* Build a local-checkout `SkillProvider`. `list()` scans the checkout for
* `SKILL.md` bundles and reads their frontmatter; `get()` re-reads one file's
* full body by its opaque locator.
*/
function createLocalSkillProvider(config, ctx) {
	return {
		name: config.providerName,
		async list(options) {
			options.signal?.throwIfAborted();
			const files = await findSkillFiles(config.localRoot);
			const candidates = [];
			for (const file of files) {
				options.signal?.throwIfAborted();
				let raw;
				try {
					raw = await readFile(file, "utf8");
				} catch (error) {
					ctx.logger.warn(`gitlab skill ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				const parsed = parseSkill(raw, ctx);
				if (parsed === void 0) continue;
				const directory = dirname(file);
				candidates.push({
					name: parsed.name,
					description: parsed.description,
					...parsed.whenToUse === void 0 ? {} : { whenToUse: parsed.whenToUse },
					invocation: parsed.invocation,
					source: config.source,
					provider: config.providerName,
					rank: config.rank,
					locator: {
						path: file,
						directory
					},
					resourceBase: {
						kind: "directory",
						path: directory
					}
				});
			}
			return candidates;
		},
		async get(candidate, options) {
			options.signal?.throwIfAborted();
			const locator = candidate.locator;
			let raw;
			try {
				raw = await readFile(locator.path, "utf8");
			} catch {
				return;
			}
			const parsed = parseSkill(raw, ctx);
			if (parsed === void 0 || parsed.name !== candidate.name) return void 0;
			return {
				name: parsed.name,
				description: parsed.description,
				...parsed.whenToUse === void 0 ? {} : { whenToUse: parsed.whenToUse },
				invocation: parsed.invocation,
				source: candidate.source,
				provider: config.providerName,
				resourceBase: {
					kind: "directory",
					path: locator.directory
				},
				content: parsed.content,
				path: locator.path
			};
		}
	};
}
//#endregion
//#region src/settings.ts
/**
* The settings namespace owning the GitLab surface's user section.
*
* The `settingsNamespace()` runtime helper was removed upstream in DSH 0.1.2-alpha
* (`refactor(services): move shared values behind service APIs`); the namespace
* string is now validated by `SettingsProvider.register` through the type-level
* `SettingsNamespaceInput`. The literal stays the same, so stored sections are
* unaffected.
*/
const GITLAB_SETTINGS_NAMESPACE = "gitlab";
/** Wire-safe skill-source schema, shared by the plugin config and the settings section. */
const GitlabSkillSourceSchema = z.object({
	id: z.string(),
	group: z.string(),
	baseUrl: z.string(),
	tokenEnv: z.string().role("credential-ref"),
	ref: z.string().default("main"),
	rank: z.natural().default(250),
	includeSubgroups: z.boolean().default(true)
});
/** Wire-safe schema: every token carries the secret role, so settings wires redact them. */
const GitlabSettingsSchema = z.object({
	token: z.string().role("secret"),
	hostTokens: z.dict(z.string().role("secret")),
	skillSources: z.array(GitlabSkillSourceSchema)
});
//#endregion
//#region src/index.ts
/**
* @lim324/dsh-gitlab — host half of the GitLab Web surface: enumerates
* the workspaces the harness knows (the workspace registry, with the launch
* cwd as fallback), detects which ones are GitLab repositories by their git
* remote, polls pipeline and open-MR snapshots per project into memory, and
* serves them to the client half over two loopback-fenced routes
* (`GET /gitlab/status`, `POST /gitlab/actions`, plus the `GET|POST
* /gitlab/settings` token route below). The client half picks the entry
* matching the current session's workspace. GitLab tokens stay on the host;
* the browser only ever sees snapshots and action results, and never reads a
* saved token back. The `gitlab` settings namespace holds the token durably
* (persisted by the settings provider); edits re-tokenize every live client
* without a restart.
* @module @lim324/dsh-gitlab
*/
const execFileAsync = promisify(execFile);
/** Stable Cordis plugin name. */
const name = "dsh-gitlab";
/** Services required before the GitLab surface can mount. */
const inject = ["webServer"];
const Config = z.object({
	token: z.string().role("secret"),
	project: z.string(),
	baseUrl: z.string(),
	pollMs: z.natural().min(5e3).default(3e4),
	tokenEnv: z.string().role("credential-ref").default("GITLAB_TOKEN"),
	skillSources: z.array(GitlabSkillSourceSchema).default([]),
	skillCloneRoot: z.string()
});
/** Upper bound for one action request body. */
const MAX_ACTION_BYTES = 8192;
/**
* Resource-safety bound, not a tunable: a skill source may hold dozens of
* repositories, and cloning or pulling them all at once would spawn a
* corresponding number of git processes and TLS connections. Run at most this
* many git operations concurrently per sync.
*/
const SKILL_SYNC_CONCURRENCY = 6;
/**
* Run `fn` over `items` with at most `limit` in-flight invocations, preserving
* order-independent completion. Failures are the caller's to handle.
* @param items - the work items.
* @param limit - the concurrency ceiling.
* @param fn - the per-item async work.
*/
async function mapWithConcurrency(items, limit, fn) {
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const item = items[cursor++];
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/**
* Validate an untrusted array into skill sources. Every entry needs a
* non-empty string `id` and `group`; the optional fields are kept only when
* their declared type matches (anything else is dropped and re-defaulted by
* the settings schema). Returns undefined when the input is not an array or
* any entry lacks id/group.
* @param value - the request body's `sources` field.
* @returns the parsed sources, or undefined when malformed.
*/
function parseSkillSources(value) {
	if (!Array.isArray(value)) return void 0;
	const sources = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return void 0;
		const row = item;
		const id = typeof row.id === "string" ? row.id : "";
		const group = typeof row.group === "string" ? row.group : "";
		if (id === "" || group === "") return void 0;
		const stringField = (key) => typeof row[key] === "string" ? row[key] : void 0;
		sources.push({
			id,
			group,
			baseUrl: stringField("baseUrl"),
			tokenEnv: stringField("tokenEnv"),
			ref: stringField("ref"),
			rank: typeof row.rank === "number" ? row.rank : void 0,
			includeSubgroups: typeof row.includeSubgroups === "boolean" ? row.includeSubgroups : void 0
		});
	}
	return sources;
}
/** Test hook: tests substitute a fake fetch and git runners; production never touches this. */
const internals = {};
/**
* Resolve the git origin remote of a directory; undefined when the directory
* is not a git checkout or has no origin.
* @param cwd - the directory to inspect.
* @param run - the git runner (injected for tests).
* @returns the parsed remote, or undefined.
*/
async function detectRemote(cwd, run = internals.runGit ?? ((dir) => execFileAsync("git", [
	"-C",
	dir,
	"remote",
	"get-url",
	"origin"
]).then((result) => result.stdout))) {
	try {
		return parseGitRemote(await run(cwd));
	} catch {
		return;
	}
}
/**
* Resolve the currently checked-out branch of a directory; undefined when
* the directory is not a git checkout (e.g. a detached HEAD).
* @param dir - the workspace directory.
* @param run - the git runner (injected for tests).
* @returns the branch name, or undefined.
*/
async function detectCurrentBranch(dir, run = internals.runGitBranch ?? ((directory) => execFileAsync("git", [
	"-C",
	directory,
	"branch",
	"--show-current"
]).then((result) => result.stdout))) {
	try {
		const branch = (await run(dir)).trim();
		return branch === "" ? void 0 : branch;
	} catch {
		return;
	}
}
/** Read a JSON body up to the size bound; undefined means over the bound or unparsable. */
async function readJsonBody(req) {
	const declared = req.headers["content-length"];
	if (declared !== void 0 && Number(declared) > MAX_ACTION_BYTES) return void 0;
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		total += buffer.length;
		if (total > MAX_ACTION_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return;
	}
}
/**
* Mount the GitLab surface: workspace enumeration, remote detection, the
* per-project polled rows, and the two fenced routes. Workspaces without a
* GitLab remote still appear with `gitlab: false` so the client half can
* render the not-a-GitLab state.
* @param ctx - plugin context carrying the webServer service.
* @param config - validated {@link Config}.
*/
function apply(ctx, config) {
	const credentials = ctx.get("credentials");
	let settingsSection;
	const resolveToken = (host) => {
		return (host !== void 0 && host !== "" ? settingsSection?.hostTokens?.[host] : void 0) ?? settingsSection?.token ?? config.token ?? credentials?.resolve(config.tokenEnv ?? "GITLAB_TOKEN")?.value ?? process.env[config.tokenEnv ?? "GITLAB_TOKEN"];
	};
	let skillSources = config.skillSources ?? [];
	let resyncProviders;
	const sourcesKey = (sources) => JSON.stringify([...sources].sort((a, b) => a.id.localeCompare(b.id)).map((source) => [
		source.id,
		source.group,
		source.baseUrl ?? null,
		source.tokenEnv ?? null,
		source.ref ?? null,
		source.rank ?? null,
		source.includeSubgroups ?? null
	]));
	const effectiveSkillSources = (settingsSources) => settingsSources !== void 0 && settingsSources.length > 0 ? settingsSources : config.skillSources ?? [];
	const rowsByProject = /* @__PURE__ */ new Map();
	const apisByProject = /* @__PURE__ */ new Map();
	const remoteByWorkspace = /* @__PURE__ */ new Map();
	const projectByWorkspace = /* @__PURE__ */ new Map();
	const defaultBranchByProject = /* @__PURE__ */ new Map();
	const branchesByProject = /* @__PURE__ */ new Map();
	const currentBranchByWorkspace = /* @__PURE__ */ new Map();
	const pollers = /* @__PURE__ */ new Map();
	const ensuring = /* @__PURE__ */ new Map();
	/** One detection result per host, so workspaces sharing a host probe once. */
	const probeByHost = /* @__PURE__ */ new Map();
	/**
	* Detect a GitLab instance by its API rather than its host name: a GET of
	* `/api/v4/version` answering 200 with a version document, or 401 (the
	* endpoint exists but demands authentication), proves the host serves the
	* GitLab API; anything else does not. Network and TLS failures leave the
	* host undetected — explicit `config.baseUrl` remains the escape hatch.
	* @param host - the remote host to probe.
	* @returns whether the host serves the GitLab API.
	*/
	const probeGitlab = async (host) => {
		const cached = probeByHost.get(host);
		if (cached !== void 0) return cached;
		let result = false;
		try {
			const res = await (internals.fetchImpl ?? fetch)(`https://${host}/api/v4/version`, { signal: AbortSignal.timeout(5e3) });
			if (res.status === 401) result = true;
			else if (res.ok) result = (await res.text()).includes("\"version\"");
		} catch {}
		probeByHost.set(host, result);
		return result;
	};
	ctx.effect(() => () => {
		for (const timer of pollers.values()) clearInterval(timer);
		pollers.clear();
	}, "dsh-gitlab: pollers");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/status",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			/* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
			const workspaceId = new URL(req.url ?? "/", "http://x").searchParams.get("workspaceId");
			if (workspaceId === null) {
				res.writeHead(400);
				res.end("missing workspaceId");
				return;
			}
			const status = await ensure(workspaceId);
			if (status === void 0) {
				res.writeHead(404);
				res.end("unknown workspace");
				return;
			}
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(status));
		}
	}), "dsh-gitlab: status route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/actions",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			const action = await readJsonBody(req);
			if (action === void 0 || typeof action.project !== "string") {
				res.writeHead(400);
				res.end("bad request");
				return;
			}
			if (action.op !== "approve" && action.op !== "merge" && action.op !== "close" && action.op !== "create-mr") {
				res.writeHead(400);
				res.end("bad request");
				return;
			}
			if (action.op !== "create-mr" && typeof action.iid !== "number") {
				res.writeHead(400);
				res.end("bad request");
				return;
			}
			const api = apisByProject.get(action.project);
			if (api === void 0) {
				res.writeHead(409);
				res.end("unknown GitLab project");
				return;
			}
			if (!api.hasToken()) {
				res.writeHead(401);
				res.end("token required");
				return;
			}
			try {
				if (action.op === "approve") {
					await api.approveMr(action.project, action.iid);
					await refresh(action.project);
				} else if (action.op === "merge") {
					await api.mergeMr(action.project, action.iid);
					await refresh(action.project);
				} else if (action.op === "close") {
					await api.closeMr(action.project, action.iid);
					await refresh(action.project);
				} else {
					const workspaceId = [...projectByWorkspace.entries()].find(([, project]) => project === action.project)?.[0];
					const source = workspaceId === void 0 ? void 0 : resolveWorkspace(workspaceId);
					const currentBranch = source === void 0 || source.path === "" ? null : await detectCurrentBranch(source.path).catch(() => null);
					const sourceBranch = action.sourceBranch !== void 0 && action.sourceBranch !== "" ? action.sourceBranch : currentBranch ?? void 0;
					if (sourceBranch === void 0) {
						res.writeHead(409);
						res.end("cannot resolve the source branch");
						return;
					}
					const targetBranch = action.targetBranch !== void 0 && action.targetBranch !== "" ? action.targetBranch : defaultBranchByProject.get(action.project) ?? "main";
					const title = action.title !== void 0 && action.title !== "" ? action.title : `Merge ${sourceBranch} into ${targetBranch}`;
					const created = await api.createMr(action.project, {
						sourceBranch,
						targetBranch,
						title
					});
					await refresh(action.project);
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: true,
						iid: created.iid,
						webUrl: created.webUrl
					}));
					return;
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				res.writeHead(502);
				res.end(error instanceof Error ? error.message : "GitLab API error");
			}
		}
	}), "dsh-gitlab: actions route");
	/** Look one workspace up by id: the registry, the cwd sentinel, or the configured project. */
	const resolveWorkspace = (workspaceId) => {
		if (config.project !== void 0) return workspaceId === "__configured__" ? {
			id: "__configured__",
			path: "",
			title: config.project
		} : void 0;
		if (workspaceId === "__cwd__") return {
			id: "__cwd__",
			path: process.cwd(),
			title: basename(process.cwd())
		};
		return ctx.get("workspaceRegistry")?.list().find((entry) => entry.id === workspaceId);
	};
	const refresh = async (project) => {
		const api = apisByProject.get(project);
		const rows = rowsByProject.get(project);
		if (api === void 0 || rows === void 0) return;
		try {
			const [pipelines, mrs, branches] = await Promise.all([
				api.listPipelines(project),
				api.listMrs(project),
				api.listBranches(project).catch(() => void 0)
			]);
			await Promise.all(pipelines.map(async (pipeline) => {
				const { jobs, commit } = await api.listPipelineJobs(project, pipeline.id);
				pipeline.jobs = jobs;
				pipeline.commit = commit;
			}));
			rows.pipelines = pipelines;
			rows.mrs = mrs;
			rows.error = null;
			if (branches !== void 0) branchesByProject.set(project, branches);
			for (const [workspaceId, workspaceProject] of projectByWorkspace) {
				if (workspaceProject !== project) continue;
				const source = resolveWorkspace(workspaceId);
				if (source === void 0 || source.path === "") continue;
				currentBranchByWorkspace.set(workspaceId, await detectCurrentBranch(source.path).catch(() => null) ?? null);
			}
		} catch (error) {
			rows.pipelines = [];
			rows.mrs = [];
			branchesByProject.set(project, []);
			rows.error = error instanceof Error ? error.message : String(error);
		}
	};
	/**
	* Resolve one workspace's status row, detecting its remote and starting a
	* poller on first request. Only workspaces the client has actually asked
	* for are ever detected or polled; unknown ids answer 404. Deduplicated per
	* workspace id, so concurrent polls of the same workspace share one
	* detection pass.
	* @param workspaceId - the workspace the client is viewing.
	* @returns the status row, or undefined for an unknown workspace.
	*/
	const ensure = (workspaceId) => {
		const pending = ensuring.get(workspaceId);
		if (pending !== void 0) return pending;
		const promise = (async () => {
			const source = resolveWorkspace(workspaceId);
			if (source === void 0) return void 0;
			if (!projectByWorkspace.has(source.id)) {
				let remote;
				if (source.path !== "") remote = await detectRemote(source.path);
				if (config.project !== void 0) {
					remoteByWorkspace.set(source.id, null);
					projectByWorkspace.set(source.id, config.project);
				} else if (remote !== void 0 && (config.baseUrl !== void 0 || await probeGitlab(remote.host))) {
					remoteByWorkspace.set(source.id, remote);
					projectByWorkspace.set(source.id, remote.project);
				} else {
					remoteByWorkspace.set(source.id, remote ?? null);
					projectByWorkspace.set(source.id, null);
				}
			}
			const project = projectByWorkspace.get(source.id) ?? null;
			if (project !== null && project !== void 0 && !apisByProject.has(project)) {
				const remote = remoteByWorkspace.get(source.id);
				const api = new GitlabApi({
					baseUrl: config.baseUrl ?? (remote === null || remote === void 0 ? "https://gitlab.com/api/v4" : `https://${remote.host}/api/v4`),
					tokenProvider: () => resolveToken(remote?.host),
					fetchImpl: internals.fetchImpl
				});
				apisByProject.set(project, api);
				rowsByProject.set(project, {
					pipelines: [],
					mrs: [],
					error: null
				});
				defaultBranchByProject.set(project, await api.getDefaultBranch(project).catch(() => null));
				branchesByProject.set(project, await api.listBranches(project).catch(() => []));
				currentBranchByWorkspace.set(source.id, source.path === "" ? null : await detectCurrentBranch(source.path).catch(() => null) ?? null);
				await refresh(project);
				pollers.set(project, setInterval(() => {
					refresh(project);
				}, config.pollMs ?? 3e4));
			}
			const rows = project === null || project === void 0 ? void 0 : rowsByProject.get(project);
			return {
				workspaceId: source.id,
				title: source.title,
				gitlab: project !== null && project !== void 0,
				remote: remoteByWorkspace.get(source.id) ?? null,
				project,
				authed: project === null || project === void 0 ? false : apisByProject.get(project)?.hasToken() ?? false,
				currentBranch: currentBranchByWorkspace.get(source.id) ?? null,
				defaultBranch: project === null || project === void 0 ? null : defaultBranchByProject.get(project) ?? null,
				branches: project === null || project === void 0 ? [] : branchesByProject.get(project) ?? [],
				pipelines: rows?.pipelines ?? [],
				mrs: rows?.mrs ?? [],
				error: rows?.error ?? null
			};
		})();
		ensuring.set(workspaceId, promise);
		promise.then(() => {
			ensuring.delete(workspaceId);
		}, () => {
			ensuring.delete(workspaceId);
		});
		return promise;
	};
	let settingsFace;
	ctx.inject(["settings"], (settingsCtx) => {
		const scope = settingsCtx.settings.register(GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema);
		settingsSection = scope.get();
		const seededSources = effectiveSkillSources(settingsSection.skillSources);
		if (sourcesKey(skillSources) !== sourcesKey(seededSources)) {
			skillSources = seededSources;
			if (resyncProviders !== void 0) resyncProviders();
		}
		const revisionOf = () => settingsCtx.settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === GITLAB_SETTINGS_NAMESPACE)?.revision;
		settingsFace = {
			get: () => {
				const section = scope.get();
				return {
					available: true,
					writable: settingsCtx.settings.writable,
					tokenSet: section.token !== void 0,
					hostTokens: Object.keys(section.hostTokens ?? {}),
					revision: revisionOf()
				};
			},
			update: async (host, token, expectedRevision) => {
				if (token === void 0) {
					const path = host === void 0 || host === "" ? ["token"] : ["hostTokens", host];
					await settingsCtx.settings.mutate(GITLAB_SETTINGS_NAMESPACE, [{
						op: "unset",
						path
					}], expectedRevision);
				} else if (host === void 0 || host === "") await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { token }, expectedRevision);
				else await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { hostTokens: { [host]: token } }, expectedRevision);
			},
			updateSources: async (sources, expectedRevision) => {
				await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { skillSources: sources }, expectedRevision);
			}
		};
		scope.watch((next) => {
			settingsSection = next;
			for (const project of rowsByProject.keys()) refresh(project);
			const nextSources = effectiveSkillSources(next.skillSources);
			if (sourcesKey(skillSources) !== sourcesKey(nextSources)) {
				skillSources = nextSources;
				if (resyncProviders !== void 0) resyncProviders();
			}
		});
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/settings",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(settingsFace?.get() ?? { available: false }));
				return;
			}
			if (req.method === "POST") {
				if (settingsFace === void 0) {
					res.writeHead(503);
					res.end("settings service is not mounted");
					return;
				}
				const action = await readJsonBody(req);
				const clear = action?.clear === true;
				const token = typeof action?.token === "string" && action.token !== "" ? action.token : void 0;
				const host = typeof action?.host === "string" && action.host !== "" ? action.host : void 0;
				if (action === void 0 || !clear && token === void 0) {
					res.writeHead(400);
					res.end("token or clear required");
					return;
				}
				const expectedRevision = typeof action.expectedRevision === "number" ? action.expectedRevision : void 0;
				try {
					await settingsFace.update(host, clear ? void 0 : token, expectedRevision);
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(settingsFace.get()));
				} catch (error) {
					if (error instanceof SettingsConflictError) {
						res.writeHead(409);
						res.end("settings-conflict");
					} else {
						res.writeHead(400);
						res.end(error instanceof Error ? error.message : "settings rejected");
					}
				}
				return;
			}
			res.writeHead(405);
			res.end();
		}
	}), "dsh-gitlab: settings route");
	const cloneRoot = config.skillCloneRoot ?? join(homedir(), ".dsh", "skills-gitlab");
	const sourceGitHost = (source) => (source.baseUrl ?? config.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/api\/v4\/?$/, "");
	const sourceHostName = (source) => sourceGitHost(source).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	const sourceToken = (source) => {
		const host = sourceHostName(source);
		const tokenEnv = source.tokenEnv ?? config.tokenEnv ?? "GITLAB_TOKEN";
		return settingsSection?.hostTokens?.[host] ?? settingsSection?.token ?? config.token ?? credentials?.resolve(tokenEnv)?.value ?? process.env[tokenEnv];
	};
	const sourceById = (id) => skillSources.find((source) => source.id === id);
	const skillStatus = async () => {
		const sources = [];
		for (const source of skillSources) {
			const checkoutRoot = join(cloneRoot, source.id);
			const local = await readdir(checkoutRoot, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).catch(() => []);
			const localSet = new Set(local);
			const api = new GitlabApi({
				baseUrl: source.baseUrl ?? config.baseUrl ?? "https://gitlab.com/api/v4",
				tokenProvider: () => sourceToken(source)
			});
			let repos = [];
			try {
				repos = (await api.listGroupProjects(source.group, source.includeSubgroups ?? true)).map((repo) => ({
					name: repo.name,
					pulled: localSet.has(repo.name)
				}));
			} catch {
				repos = local.map((name) => ({
					name,
					pulled: true
				}));
			}
			sources.push({
				...source,
				repos
			});
		}
		return { sources };
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/skills/status",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			try {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					...await skillStatus(),
					revision: settingsFace?.get().revision
				}));
			} catch (error) {
				res.writeHead(500);
				res.end(error instanceof Error ? error.message : "status failed");
			}
		}
	}), "dsh-gitlab: skills status route");
	const syncRepoRow = async (checkoutRoot, source, repo) => {
		const dest = join(checkoutRoot, repo.name);
		if (existsSync(dest)) {
			await refreshOriginToken(dest, sourceToken(source));
			await gitPull(dest);
		} else await gitClone(`${sourceGitHost(source)}/${repo.pathWithNamespace}.git`, sourceToken(source), dest);
	};
	const syncSource = async (source) => {
		const checkoutRoot = join(cloneRoot, source.id);
		await mkdir(checkoutRoot, { recursive: true });
		await mapWithConcurrency(await new GitlabApi({
			baseUrl: source.baseUrl ?? config.baseUrl ?? "https://gitlab.com/api/v4",
			tokenProvider: () => sourceToken(source)
		}).listGroupProjects(source.group, source.includeSubgroups ?? true), SKILL_SYNC_CONCURRENCY, async (repo) => {
			try {
				await syncRepoRow(checkoutRoot, source, repo);
			} catch (error) {
				ctx.logger.warn(`dsh-gitlab: skill repo ${repo.pathWithNamespace} sync failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	};
	const syncRepo = async (source, repoName) => {
		const checkoutRoot = join(cloneRoot, source.id);
		await mkdir(checkoutRoot, { recursive: true });
		const repo = (await new GitlabApi({
			baseUrl: source.baseUrl ?? config.baseUrl ?? "https://gitlab.com/api/v4",
			tokenProvider: () => sourceToken(source)
		}).listGroupProjects(source.group, source.includeSubgroups ?? true)).find((candidate) => candidate.name === repoName);
		if (repo === void 0) throw new Error(`repository "${repoName}" is not in group ${source.group}`);
		await syncRepoRow(checkoutRoot, source, repo);
	};
	const invalidators = /* @__PURE__ */ new Map();
	const invalidateAll = () => {
		for (const invalidate of invalidators.values()) invalidate();
	};
	ctx.inject(["skills"], (skillsCtx) => {
		const cleanups = [];
		resyncProviders = () => {
			for (const cleanup of cleanups) cleanup();
			cleanups.length = 0;
			invalidators.clear();
			for (const source of skillSources) {
				const provider = createLocalSkillProvider({
					localRoot: join(cloneRoot, source.id),
					rank: source.rank ?? 250,
					source: "gitlab",
					providerName: `gitlab:${source.id}`
				}, ctx);
				cleanups.push(skillsCtx.skills.registerProvider((control) => {
					invalidators.set(source.id, control.invalidate);
					return provider;
				}));
			}
			invalidateAll();
		};
		resyncProviders();
		skillsCtx.effect(() => () => {
			for (const cleanup of cleanups) cleanup();
			cleanups.length = 0;
		});
	});
	const requireApproval = async (exec, toolName, reason) => {
		const approval = ctx.get("approval");
		if (approval === void 0 || exec.agent === void 0) throw new Error(`${toolName} cannot be approved in this context`);
		const outcome = await approval.request({
			agent: exec.agent,
			toolName,
			reason,
			signal: exec.signal
		});
		if (outcome !== "allowed-once") throw new Error(`${toolName} not approved: ${outcome}`);
	};
	ctx.inject(["tools"], (toolCtx) => {
		toolCtx.tools.register(defineTool({
			name: "gitlab_skill_pull",
			description: "Sync GitLab-backed skills into the local checkout so the skill catalog reflects the latest remote state. Omit sourceId to sync every configured source.",
			parameters: { sourceId: {
				type: "string",
				description: "Optional source id; omit to sync every configured source."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { synced: {
						type: "array",
						items: { type: "string" },
						required: true
					} }
				},
				render: (_args, value) => [{
					type: "text",
					text: `Synced skill sources: ${value.synced.join(", ")}`
				}]
			},
			async execute(args) {
				const target = typeof args.sourceId === "string" ? sourceById(args.sourceId) : void 0;
				const targets = target !== void 0 ? [target] : skillSources;
				await Promise.all(targets.map((source) => syncSource(source)));
				invalidateAll();
				return { synced: targets.map((source) => source.id) };
			},
			presentCall(args) {
				return {
					card: "generic",
					title: "Pull GitLab skills",
					kind: "fetch",
					rawInput: args.sourceId ?? "all"
				};
			}
		}));
		toolCtx.tools.register(defineTool({
			name: "gitlab_skill_save",
			description: "Write one checked-out skill's SKILL.md back to its GitLab repository (commit + push). Requires approval.",
			parameters: {
				sourceId: {
					type: "string",
					required: true,
					description: "The source id."
				},
				repo: {
					type: "string",
					required: true,
					description: "The repository (skill) name."
				},
				content: {
					type: "string",
					required: true,
					description: "The full SKILL.md content to write."
				},
				message: {
					type: "string",
					description: "Optional commit message."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { repo: {
						type: "string",
						required: true
					} }
				},
				render: (_args, value) => [{
					type: "text",
					text: `Saved skill ${String(value.repo)}`
				}]
			},
			async execute(args, exec) {
				const source = sourceById(args.sourceId);
				if (source === void 0) throw new Error(`unknown sourceId "${args.sourceId}"`);
				const dest = join(cloneRoot, source.id, args.repo);
				if (!existsSync(dest)) throw new Error(`skill repository "${args.repo}" is not checked out; pull it first`);
				await requireApproval(exec, "gitlab_skill_save", `commit SKILL.md of "${args.repo}" to ${source.group}`);
				await writeFile(join(dest, "SKILL.md"), args.content);
				await refreshOriginToken(dest, sourceToken(source));
				await gitCommitPush(dest, typeof args.message === "string" && args.message !== "" ? args.message : `update skill ${args.repo}`);
				invalidateAll();
				return { repo: args.repo };
			},
			presentCall(args) {
				return {
					card: "generic",
					title: `Save skill ${args.repo}`,
					kind: "edit",
					rawInput: args.repo
				};
			}
		}));
		toolCtx.tools.register(defineTool({
			name: "gitlab_skill_remove",
			description: "Delete only the local checkout of one skill; the remote GitLab repository is left untouched.",
			parameters: {
				sourceId: {
					type: "string",
					required: true,
					description: "The source id."
				},
				repo: {
					type: "string",
					required: true,
					description: "The repository (skill) name."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { repo: {
						type: "string",
						required: true
					} }
				},
				render: (_args, value) => [{
					type: "text",
					text: `Removed local checkout of ${String(value.repo)}`
				}]
			},
			async execute(args) {
				const source = sourceById(args.sourceId);
				if (source === void 0) throw new Error(`unknown sourceId "${args.sourceId}"`);
				await rm(join(cloneRoot, source.id, args.repo), {
					recursive: true,
					force: true
				});
				invalidateAll();
				return { repo: args.repo };
			},
			presentCall(args) {
				return {
					card: "generic",
					title: `Remove local skill ${args.repo}`,
					kind: "delete",
					rawInput: args.repo
				};
			}
		}));
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/skills/pull",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			const body = await readJsonBody(req);
			const target = typeof body?.sourceId === "string" ? sourceById(body.sourceId) : void 0;
			if (body?.sourceId !== void 0 && target === void 0) {
				res.writeHead(404);
				res.end("unknown sourceId");
				return;
			}
			const repo = typeof body?.repo === "string" && body.repo !== "" ? body.repo : void 0;
			try {
				if (repo !== void 0) {
					if (target === void 0) throw new Error("repo requires a sourceId");
					await syncRepo(target, repo);
				} else {
					const targets = target !== void 0 ? [target] : skillSources;
					await Promise.all(targets.map((source) => syncSource(source)));
				}
				invalidateAll();
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				res.writeHead(500);
				res.end(error instanceof Error ? error.message : "sync failed");
			}
		}
	}), "dsh-gitlab: skills pull route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/skills/save",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			const body = await readJsonBody(req);
			const source = typeof body?.sourceId === "string" ? sourceById(body.sourceId) : void 0;
			const repo = typeof body?.repo === "string" && body.repo !== "" ? body.repo : void 0;
			const content = typeof body?.content === "string" ? body.content : void 0;
			if (source === void 0 || repo === void 0 || content === void 0) {
				res.writeHead(400);
				res.end("sourceId, repo, and content are required");
				return;
			}
			const dest = join(cloneRoot, source.id, repo);
			if (!existsSync(dest)) {
				res.writeHead(404);
				res.end("skill repository is not checked out; pull it first");
				return;
			}
			try {
				await writeFile(join(dest, "SKILL.md"), content);
				await refreshOriginToken(dest, sourceToken(source));
				await gitCommitPush(dest, typeof body?.message === "string" && body.message !== "" ? body.message : `update skill ${repo}`);
				invalidateAll();
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				res.writeHead(500);
				res.end(error instanceof Error ? error.message : "save failed");
			}
		}
	}), "dsh-gitlab: skills save route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/skills/remove",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			const body = await readJsonBody(req);
			const source = typeof body?.sourceId === "string" ? sourceById(body.sourceId) : void 0;
			const repo = typeof body?.repo === "string" && body.repo !== "" ? body.repo : void 0;
			if (source === void 0 || repo === void 0) {
				res.writeHead(400);
				res.end("sourceId and repo are required");
				return;
			}
			try {
				await rm(join(cloneRoot, source.id, repo), {
					recursive: true,
					force: true
				});
				invalidateAll();
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				res.writeHead(500);
				res.end(error instanceof Error ? error.message : "remove failed");
			}
		}
	}), "dsh-gitlab: skills remove route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/gitlab/skills/sources",
		handler: async (req, res) => {
			if (!isTrustedLocalRequest(req)) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					sources: skillSources,
					revision: settingsFace?.get().revision
				}));
				return;
			}
			if (req.method === "POST") {
				if (settingsFace === void 0) {
					res.writeHead(503);
					res.end("settings service is not mounted");
					return;
				}
				const body = await readJsonBody(req);
				const sources = parseSkillSources(body?.sources);
				if (sources === void 0) {
					res.writeHead(400);
					res.end("sources must be an array of { id, group } objects");
					return;
				}
				const expectedRevision = typeof body?.expectedRevision === "number" ? body.expectedRevision : void 0;
				try {
					await settingsFace.updateSources(sources, expectedRevision);
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ ok: true }));
				} catch (error) {
					if (error instanceof SettingsConflictError) {
						res.writeHead(409);
						res.end("settings-conflict");
					} else {
						res.writeHead(400);
						res.end(error instanceof Error ? error.message : "sources rejected");
					}
				}
				return;
			}
			res.writeHead(405);
			res.end();
		}
	}), "dsh-gitlab: skills sources route");
}
//#endregion
export { Config, GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, GitlabSkillSourceSchema, apply, detectCurrentBranch, detectRemote, inject, internals, name };
