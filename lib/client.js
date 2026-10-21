window.__ModuleLoader__.load({
	id: "@lim324/dsh-gitlab",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/mr.tsx
		/**
		* Message-page MR review surfaces.
		*
		* Three mounts, all first-party React over the host's read-only MR routes:
		* - `conversation.chat.turnTail`: a card at the end of the turn whose answer
		*   links a merge request, showing the release-gate evidence (commit
		*   authorship, merge commits, conflicts, changed files).
		* - `conversation.composer.dock`: a slim status bar for the current branch's
		*   open merge requests.
		* - `sidebar.right.pane.tab`: the full review pane (file list + unified diff).
		*
		* Nothing here calls the model. Card/pane actions only read; merge and approve
		* stay in the GitLab tab, so a review card can never merge by accident.
		* @module @lim324/dsh-gitlab/client/mr
		*/
		/** The user-turn text a merge request from the card submits. */
		function mergePrompt(input) {
			return [
				`请合入这个 MR（用户已在审查卡上明确确认）：!${String(input.iid)} → ${input.targetBranch}`,
				`源分支：${input.sourceBranch}`,
				...input.webUrl === null ? [] : [input.webUrl],
				"",
				"执行前请重新 fetch，并按 release-mr 的闸门复核（G1–G4；staging 用 S1–S6）。",
				"任一闸不过就停手并列出证据，不要试合、不要强推。"
			].join("\n");
		}
		/** Stable identities of the sidebar tab type and its body entry. */
		const MR_TAB_KIND = "gitlab-mr-review";
		const MR_TAB_ID = "@lim324/dsh-gitlab/mr-review";
		const DETAIL_TTL_MS = 3e4;
		const PATCH_CACHE_LIMIT = 40;
		const SHOWN_DIFF_LINES = 1200;
		const BASELINE_PREFIX = "dsh-gitlab.mr-baseline.v1:";
		var HttpError = class extends Error {
			status;
			constructor(status, message) {
				super(message);
				this.name = "HttpError";
				this.status = status;
			}
		};
		async function getJson(url, signal) {
			const response = await fetch(url, { signal });
			if (!response.ok) {
				let note = `HTTP ${String(response.status)}`;
				try {
					const body = await response.json();
					if (typeof body.error === "string") note = body.error;
				} catch {}
				throw new HttpError(response.status, note);
			}
			return await response.json();
		}
		const detailCache = /* @__PURE__ */ new Map();
		const detailInflight = /* @__PURE__ */ new Map();
		const sessionRefsInflight = /* @__PURE__ */ new Map();
		const patchCache = /* @__PURE__ */ new Map();
		function detailKey(cwd, project, iid) {
			return `${cwd}\u0000${project}!${String(iid)}`;
		}
		/**
		* Every turn's MR links for one Session, in one request. A long Session
		* renders many turn tails; coalescing them keeps the first paint to one call
		* instead of one per turn.
		*/
		async function loadSessionRefs(sessionId) {
			const inflight = sessionRefsInflight.get(sessionId);
			if (inflight !== void 0) return inflight;
			const promise = getJson(`/gitlab/session-mrs?${new URLSearchParams({ sessionId }).toString()}`).then((body) => body.turns !== void 0 && body.turns !== null && typeof body.turns === "object" ? body.turns : {}).finally(() => {
				sessionRefsInflight.delete(sessionId);
			});
			sessionRefsInflight.set(sessionId, promise);
			return promise;
		}
		async function loadDetail(input, options = {}) {
			const key = detailKey(input.cwd, input.project, input.iid);
			if (options.refresh !== true) {
				const cached = detailCache.get(key);
				if (cached !== void 0 && Date.now() - cached.at < DETAIL_TTL_MS) return cached.value;
				const inflight = detailInflight.get(key);
				if (inflight !== void 0) return inflight;
			}
			const params = new URLSearchParams({
				cwd: input.cwd,
				project: input.project,
				iid: String(input.iid)
			});
			if (options.refresh === true) params.set("refresh", "1");
			const promise = getJson(`/gitlab/mr?${params.toString()}`, options.signal).then((value) => {
				detailCache.set(key, {
					at: Date.now(),
					value
				});
				while (detailCache.size > 30) {
					const oldest = detailCache.keys().next().value;
					if (oldest === void 0) break;
					detailCache.delete(oldest);
				}
				return value;
			}).finally(() => {
				detailInflight.delete(key);
			});
			if (options.refresh !== true) detailInflight.set(key, promise);
			return promise;
		}
		async function loadPatch(input, options = {}) {
			const key = detailKey(input.cwd, input.project, input.iid) + `\u0000${input.path}`;
			if (options.refresh !== true) {
				const cached = patchCache.get(key);
				if (cached !== void 0) return cached;
			}
			const value = await getJson(`/gitlab/mr/file?${new URLSearchParams({
				cwd: input.cwd,
				project: input.project,
				iid: String(input.iid),
				path: input.path
			}).toString()}`);
			patchCache.set(key, value);
			while (patchCache.size > PATCH_CACHE_LIMIT) {
				const oldest = patchCache.keys().next().value;
				if (oldest === void 0) break;
				patchCache.delete(oldest);
			}
			return value;
		}
		/** Read one MR's saved commit baseline, if this browser saved one. */
		function readBaseline(sessionId, turn, iid) {
			try {
				const raw = globalThis.sessionStorage?.getItem(`${BASELINE_PREFIX}${sessionId}:${String(turn)}:${String(iid)}`);
				if (typeof raw !== "string") return null;
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed.commits) && parsed.commits.every((item) => typeof item === "string") ? { commits: parsed.commits } : null;
			} catch {
				return null;
			}
		}
		function writeBaseline(sessionId, turn, iid, commits) {
			try {
				globalThis.sessionStorage?.setItem(`${BASELINE_PREFIX}${sessionId}:${String(turn)}:${String(iid)}`, JSON.stringify({ commits }));
			} catch {}
		}
		/**
		* Show GitLab's own vocabulary instead of translating it: reviewers compare the
		* chip with the API, docs and CI output. State wins for a merged/closed MR
		* (it reports `detailed_merge_status: "not_open"` there); otherwise the
		* mergeability verdict is the useful value. Tone only color-codes it.
		*/
		function statusLabel(mr) {
			const state = typeof mr.state === "string" && mr.state !== "" ? mr.state : "unknown";
			if (state !== "opened") return {
				text: state,
				tone: state === "merged" ? "ok" : "muted"
			};
			if (mr.hasConflicts) return {
				text: "conflict",
				tone: "bad"
			};
			if (mr.detailedMergeStatus !== null && mr.detailedMergeStatus !== "") return {
				text: mr.detailedMergeStatus,
				tone: mergeTone(mr.detailedMergeStatus)
			};
			if (mr.mergeStatus !== null && mr.mergeStatus !== "") return {
				text: mr.mergeStatus,
				tone: mr.mergeStatus === "can_be_merged" ? "ok" : mr.mergeStatus === "cannot_be_merged" ? "bad" : "muted"
			};
			return {
				text: "unknown",
				tone: "muted"
			};
		}
		/** Tone for one GitLab mergeability verdict. */
		function mergeTone(status) {
			if (status === "mergeable") return "ok";
			if (status === "checking" || status === "unchecked" || status === "not_open") return "muted";
			if (status === "conflict" || status === "broken_status") return "bad";
			return "warn";
		}
		function fileLetter(status) {
			if (status === "added") return "A";
			if (status === "deleted") return "D";
			if (status === "renamed") return "R";
			return "M";
		}
		function formatDate(raw) {
			if (raw === null) return "";
			const date = new Date(raw);
			if (Number.isNaN(date.getTime())) return "";
			return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}
		function diffLineClass(line) {
			if (line.startsWith("@@")) return "gli-diff-hunk";
			if (line.startsWith("+") && !line.startsWith("+++")) return "gli-diff-add";
			if (line.startsWith("-") && !line.startsWith("---")) return "gli-diff-del";
			if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) return "gli-diff-meta";
			return "";
		}
		function Svg({ size = 16, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children
			});
		}
		function IconMr({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Svg, {
				size,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "4",
						cy: "3.5",
						r: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "12",
						cy: "3.5",
						r: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "12.5",
						r: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 5v1a3 3 0 0 0 3 3M12 5v1a3 3 0 0 1-3 3M8 9v2" })
				]
			});
		}
		function IconChevron({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 6.5 8 10.5l4-4" })
			});
		}
		function IconBack({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9.5 3.5 5 8l4.5 4.5" })
			});
		}
		function IconRefresh({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13 8a5 5 0 1 1-1.6-3.7M13 3v2.6h-2.6" })
			});
		}
		function IconExternal({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Svg, {
				size,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 3h4v4M13 3 7.5 8.5" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" })]
			});
		}
		function IconCopy({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Svg, {
				size,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "5.5",
					y: "5.5",
					width: "7",
					height: "7",
					rx: "1.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" })]
			});
		}
		function IconUp({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 13V3M4 7l4-4 4 4" })
			});
		}
		function IconDown({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 3v10M4 9l4 4 4-4" })
			});
		}
		function IconClose({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Svg, {
				size,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" })
			});
		}
		function IconPanel({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Svg, {
				size,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "2.5",
					y: "3",
					width: "11",
					height: "10",
					rx: "1.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9.5 3v10" })]
			});
		}
		function IconSpark({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Svg, {
				size,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 2.5l1.1 2.9L12 6.5l-2.9 1.1L8 10.5 6.9 7.6 4 6.5l2.9-1.1L8 2.5Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.5 10.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" })]
			});
		}
		function MrTurnTail(props) {
			const { host, ...rest } = props;
			const sessionId = typeof rest.sessionId === "string" ? rest.sessionId : void 0;
			const turnLocation = rest.turn;
			const turn = typeof turnLocation === "number" ? turnLocation : typeof turnLocation === "object" && turnLocation !== null && typeof turnLocation.turn === "number" ? turnLocation.turn : void 0;
			const cwd = (rest.useSessions ?? (() => void 0))((state) => {
				const byId = state?.byId;
				return sessionId === void 0 ? void 0 : byId?.[sessionId]?.cwd;
			});
			const [items, setItems] = (0, react.useState)([]);
			const [hasRefs, setHasRefs] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)("");
			const [expanded, setExpanded] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("commits");
			const [onlyOthers, setOnlyOthers] = (0, react.useState)(false);
			const [commitFiles, setCommitFiles] = (0, react.useState)({});
			const [fileFilter, setFileFilter] = (0, react.useState)(null);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [confirmMerge, setConfirmMerge] = (0, react.useState)(null);
			const [mergeState, setMergeState] = (0, react.useState)({});
			const mounted = (0, react.useRef)(true);
			const inflight = (0, react.useRef)(null);
			(0, react.useEffect)(() => () => {
				mounted.current = false;
				inflight.current?.abort();
			}, []);
			const load = (0, react.useCallback)(async (refresh) => {
				if (sessionId === void 0 || turn === void 0 || cwd === void 0) return;
				inflight.current?.abort();
				const controller = new AbortController();
				inflight.current = controller;
				if (refresh) setRefreshing(true);
				setError("");
				try {
					const refs = (await loadSessionRefs(sessionId))[String(turn)] ?? [];
					if (refs.length > 0 && mounted.current) setHasRefs(true);
					const next = [];
					for (const ref of refs) try {
						const detail = await loadDetail({
							cwd,
							project: ref.project,
							iid: ref.iid
						}, {
							signal: controller.signal,
							refresh
						});
						const baseline = readBaseline(sessionId, turn, ref.iid);
						const ids = detail.commits.map((commit) => commit.id);
						if (baseline === null) writeBaseline(sessionId, turn, ref.iid, ids);
						const known = new Set(baseline?.commits ?? ids);
						next.push({
							ref,
							detail,
							newCommits: detail.commits.filter((commit) => !known.has(commit.id)).map((commit) => commit.id)
						});
					} catch (failure) {
						if (!(failure instanceof HttpError) || failure.status !== 404) throw failure;
					}
					if (!mounted.current) return;
					setItems(next);
				} catch (failure) {
					if (!mounted.current || controller.signal.aborted) return;
					setError(failure instanceof Error ? failure.message : "加载失败");
				} finally {
					if (mounted.current) setRefreshing(false);
				}
			}, [
				cwd,
				sessionId,
				turn
			]);
			(0, react.useEffect)(() => {
				load(false);
			}, [load]);
			const openReview = (detail, path) => {
				if (cwd === void 0 || !host.canOpenReview) return;
				host.openReview({
					cwd,
					project: detail.project,
					iid: detail.mr.iid,
					path
				});
			};
			const loadCommitFiles = async (detail, commit) => {
				if (cwd === void 0) return;
				const key = `${String(detail.mr.iid)}:${commit.id}`;
				setCommitFiles((previous) => ({
					...previous,
					[key]: { loading: true }
				}));
				try {
					const body = await getJson(`/gitlab/mr/commit?${new URLSearchParams({
						cwd,
						project: detail.project,
						iid: String(detail.mr.iid),
						sha: commit.id
					}).toString()}`);
					if (!mounted.current) return;
					setCommitFiles((previous) => ({
						...previous,
						[key]: {
							loading: false,
							files: body.files
						}
					}));
				} catch {
					if (!mounted.current) return;
					setCommitFiles((previous) => ({
						...previous,
						[key]: {
							loading: false,
							error: "无法读取提交文件"
						}
					}));
				}
			};
			const askAgentToMerge = async (detail) => {
				const iid = detail.mr.iid;
				setConfirmMerge(null);
				setMergeState((previous) => ({
					...previous,
					[iid]: "sending"
				}));
				try {
					await host.mergeViaAgent({
						sessionId: sessionId ?? "",
						project: detail.project,
						iid,
						sourceBranch: detail.mr.sourceBranch,
						targetBranch: detail.mr.targetBranch,
						webUrl: detail.mr.webUrl
					});
					if (mounted.current) setMergeState((previous) => ({
						...previous,
						[iid]: "sent"
					}));
				} catch {
					if (mounted.current) setMergeState((previous) => ({
						...previous,
						[iid]: "error"
					}));
				}
			};
			const markRead = (item) => {
				if (sessionId === void 0 || turn === void 0) return;
				writeBaseline(sessionId, turn, item.detail.mr.iid, item.detail.commits.map((commit) => commit.id));
				setItems((previous) => previous.map((entry) => entry.detail.mr.iid === item.detail.mr.iid ? {
					...entry,
					newCommits: []
				} : entry));
			};
			if (sessionId === void 0 || turn === void 0 || cwd === void 0) return null;
			if (items.length === 0 && error === "") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "gli-tail",
				children: [items.map((item) => {
					const detail = item.detail;
					const mr = detail.mr;
					const status = statusLabel(mr);
					const others = detail.commits.filter((commit) => commit.mine === "other");
					const unknown = detail.commits.filter((commit) => commit.mine === "unknown");
					const merges = detail.commits.filter((commit) => commit.mergeSuspect);
					const additions = detail.files.reduce((total, file) => total + file.additions, 0);
					const deletions = detail.files.reduce((total, file) => total + file.deletions, 0);
					const commitsShown = onlyOthers ? others : detail.commits;
					const visibleFiles = fileFilter !== null && fileFilter.iid === mr.iid ? detail.files.filter((file) => fileFilter.paths.includes(file.path)) : detail.files;
					const warnings = [];
					if (others.length > 0) warnings.push(`${others.length} 条他人的提交`);
					if (merges.length > 0) warnings.push(`${merges.length} 个 merge 提交`);
					if (unknown.length > 0) warnings.push(`${unknown.length} 条作者未知`);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "gli-card",
						"aria-label": `合并请求 !${String(mr.iid)} 审查`,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-card-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "gli-expand gli-head-main",
									onClick: () => setExpanded((value) => !value),
									"aria-expanded": expanded,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-tile",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMr, { size: 18 })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "gli-head-copy",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "gli-head-line",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-mr",
														children: ["!", mr.iid]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-branch",
														children: ["→ ", mr.targetBranch]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-chevron",
														"data-open": expanded ? "true" : void 0,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevron, {})
													})
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "gli-card-title",
												children: mr.title
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "gli-card-meta",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: `gli-status gli-status-${status.tone}`,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "gli-status-dot",
															"aria-hidden": "true"
														}), status.text]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-sep",
														children: "·"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-num",
														children: [detail.commits.length, detail.hasMoreCommits ? "+" : ""]
													}), " 提交"] }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-sep",
														children: "·"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-num",
														children: [detail.files.length, detail.hasMoreFiles ? "+" : ""]
													}), " 文件"] }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-sep",
														children: "·"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-counts",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "gli-plus",
															children: ["+", additions]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "gli-minus",
															children: ["−", deletions]
														})]
													})
												]
											}),
											warnings.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "gli-warn-line",
												children: warnings.join(" · ")
											}) : detail.commits.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "gli-ok-line",
												children: "提交均为你"
											}) : null
										]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "gli-icon-btn",
									title: "刷新",
									"aria-label": "刷新合并请求",
									disabled: refreshing,
									onClick: () => {
										load(true);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefresh, { size: 15 })
								})]
							}),
							item.newCommits.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-note",
								children: [
									"自上次查看后 +",
									item.newCommits.length,
									" 提交",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "gli-link-btn",
										onClick: () => markRead(item),
										children: "标记已读"
									})
								]
							}),
							detail.identity.email === null && detail.identity.name === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "gli-note gli-note-muted",
								children: "本仓库未配置 git 作者，提交归属显示为「未知」。"
							}),
							expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-body",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-body-bar",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "gli-seg",
											role: "tablist",
											"aria-label": "审查视图",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												role: "tab",
												"aria-selected": tab === "commits",
												className: "gli-seg-item gli-tab",
												onClick: () => setTab("commits"),
												children: ["提交 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "gli-num",
													children: detail.commits.length
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												role: "tab",
												"aria-selected": tab === "files",
												className: "gli-seg-item gli-tab",
												onClick: () => setTab("files"),
												children: ["文件 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "gli-num",
													children: detail.files.length
												})]
											})]
										}), tab === "commits" && others.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: onlyOthers ? "gli-text-btn gli-text-btn-on" : "gli-text-btn",
											"aria-pressed": onlyOthers,
											onClick: () => setOnlyOthers((value) => !value),
											children: "只看他人"
										})]
									}),
									tab === "commits" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-list",
										children: [commitsShown.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "gli-empty",
											children: "没有符合条件的提交"
										}), commitsShown.map((commit) => {
											const key = `${String(mr.iid)}:${commit.id}`;
											const drill = commitFiles[key];
											const isNew = item.newCommits.includes(commit.id);
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "gli-row-wrap",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "gli-row gli-commit",
													onClick: () => {
														loadCommitFiles(detail, commit);
													},
													"aria-expanded": drill?.files !== void 0,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-row-main",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "gli-row-title",
															children: commit.title
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "gli-row-sub",
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: `gli-author gli-author-${commit.mine === "me" ? "me" : commit.mine === "other" ? "other" : "unknown"}`,
																	children: commit.mine === "me" ? "你" : commit.mine === "other" ? "他人" : "未知"
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sep",
																	children: "·"
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sha",
																	children: commit.shortId
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sep",
																	children: "·"
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sub-text",
																	children: commit.authorName ?? "未知作者"
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sep",
																	children: "·"
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-sub-text",
																	children: formatDate(commit.authoredDate)
																}),
																commit.mergeSuspect && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-tag",
																	children: "merge"
																})
															]
														})]
													}), isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-new",
														title: "新提交",
														"aria-label": "新提交"
													})]
												}), drill !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "gli-drill",
													children: [
														drill.loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "gli-muted-text",
															children: "读取提交文件…"
														}),
														drill.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "gli-error-text",
															children: drill.error
														}),
														drill.files !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: "gli-drill-title",
																children: [
																	"这条提交改了 ",
																	drill.files.length,
																	" 个文件"
																]
															}),
															drill.files.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
																className: "gli-drill-row",
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: `gli-file-letter gli-file-${file.status}`,
																	children: fileLetter(file.status)
																}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "gli-path",
																	title: file.path,
																	children: file.path
																})]
															}, file.path)),
															drill.files.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: "gli-link-btn",
																onClick: () => {
																	setFileFilter({
																		iid: mr.iid,
																		sha: commit.shortId,
																		paths: drill.files?.map((file) => file.path) ?? []
																	});
																	setTab("files");
																},
																children: "在文件列表里只看这些"
															})
														] })
													]
												})]
											}, commit.id);
										})]
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-list",
										children: [
											fileFilter !== null && fileFilter.iid === mr.iid && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "gli-filter-chip",
												children: [
													"只看提交 ",
													fileFilter.sha,
													" 的文件",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "gli-link-btn",
														onClick: () => setFileFilter(null),
														children: "清除"
													})
												]
											}),
											visibleFiles.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "gli-empty",
												children: "没有文件"
											}),
											visibleFiles.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "gli-row",
												onClick: () => {
													if (host.canOpenReview) openReview(detail, file.path);
												},
												disabled: !host.canOpenReview,
												title: host.canOpenReview ? "打开 diff" : "请在 GitLab 中查看",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: `gli-file-letter gli-file-${file.status}`,
														children: fileLetter(file.status)
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-path",
														title: file.path,
														children: file.path
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-stats",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "gli-plus",
															children: ["+", file.additions]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: "gli-minus",
															children: ["−", file.deletions]
														})]
													}),
													file.binary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-tag",
														children: "binary"
													})
												]
											}, file.path)),
											(detail.hasMoreFiles || detail.overflow) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "gli-empty",
												children: [
													"仅显示前 ",
													detail.files.length,
													" 个文件",
													detail.overflow ? "（GitLab 已截断）" : "",
													"，其余请在 GitLab 查看。"
												]
											})
										]
									}),
									confirmMerge === mr.iid && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-callout",
										role: "alertdialog",
										"aria-label": `确认让 Agent 合入 !${String(mr.iid)}`,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-callout-text",
											children: [
												"确认让 Agent 合入 ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
													"!",
													mr.iid,
													" → ",
													mr.targetBranch
												] }),
												"？ 它会先重新拉取并复核闸门，任一不过就停手。这一步只会发送一条对话消息，不会直接调用 GitLab 合并。"
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-callout-actions",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												type: "button",
												variant: "outline",
												size: "sm",
												onClick: () => setConfirmMerge(null),
												children: "取消"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												type: "button",
												variant: "primary",
												size: "sm",
												onClick: () => {
													askAgentToMerge(detail);
												},
												children: "确认发送"
											})]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-foot",
										children: [
											host.canMergeViaAgent && sessionId !== void 0 && mr.state === "opened" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "gli-text-btn",
												disabled: mergeState[mr.iid] === "sending" || mergeState[mr.iid] === "sent",
												onClick: () => setConfirmMerge(mr.iid),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSpark, { size: 14 }), mergeState[mr.iid] === "sent" ? "已发送给 Agent" : mergeState[mr.iid] === "sending" ? "发送中…" : "让 Agent 合入"]
											}),
											mergeState[mr.iid] === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "gli-error-text",
												children: "消息发送失败，请重试"
											}),
											host.canOpenReview && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "gli-text-btn",
												onClick: () => openReview(detail),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPanel, { size: 14 }), "展开审查"]
											}),
											mr.webUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
												className: "gli-text-btn gli-action-link",
												href: mr.webUrl,
												target: "_blank",
												rel: "noreferrer",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconExternal, { size: 14 }), "GitLab"]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "gli-time",
												children: ["更新于 ", formatDate(detail.fetchedAt)]
											})
										]
									})
								]
							})
						]
					}, `${detail.project}!${String(mr.iid)}`);
				}), error !== "" && hasRefs && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "gli-card gli-error-card",
					children: [
						"审查数据加载失败：",
						error,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "gli-link-btn",
							onClick: () => {
								load(true);
							},
							children: "重试"
						})
					]
				})]
			});
		}
		function MrDock(props) {
			const { host, ...rest } = props;
			const sessionId = typeof rest.sessionId === "string" ? rest.sessionId : void 0;
			const cwd = (rest.useSessions ?? (() => void 0))((state) => {
				const byId = state?.byId;
				return sessionId === void 0 ? void 0 : byId?.[sessionId]?.cwd;
			});
			const [state, setState] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (cwd === void 0) return;
				let alive = true;
				const load = async () => {
					try {
						const body = await getJson(`/gitlab/branch-mrs?cwd=${encodeURIComponent(cwd)}`);
						if (alive) setState(body);
					} catch {
						if (alive) setState(null);
					}
				};
				load();
				const timer = setInterval(() => {
					load();
				}, 3e4);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [cwd]);
			if (state === null || state.mrs.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "gli-dock",
				"aria-label": `当前分支 ${state.branch ?? ""} 的合并请求`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "gli-dock-icon",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMr, { size: 14 })
					}),
					state.branch !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "gli-dock-branch",
						title: state.branch,
						children: state.branch
					}),
					state.mrs.map((mr) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "gli-dock-item",
						disabled: !host.canOpenReview,
						onClick: () => {
							if (cwd !== void 0 && host.canOpenReview) host.openReview({
								cwd,
								project: state.project,
								iid: mr.iid
							});
						},
						title: mr.title,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "gli-mr",
							children: ["!", mr.iid]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "gli-dock-target",
							children: ["→ ", mr.targetBranch]
						})]
					}, mr.iid))
				]
			});
		}
		function MrReviewPane(props) {
			const { host, ...rest } = props;
			const info = (rest.useTabInfo ?? (() => ({})))();
			const params = info?.tab?.navigation?.params ?? {};
			const cwd = typeof params.cwd === "string" ? params.cwd : void 0;
			const project = typeof params.project === "string" && params.project !== "" ? params.project : void 0;
			const iid = typeof params.iid === "number" ? params.iid : void 0;
			const initialPath = typeof params.path === "string" ? params.path : void 0;
			const [payload, setPayload] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [loading, setLoading] = (0, react.useState)(false);
			const [selected, setSelected] = (0, react.useState)(initialPath ?? null);
			const [patch, setPatch] = (0, react.useState)(null);
			const [patchError, setPatchError] = (0, react.useState)("");
			const [patchLoading, setPatchLoading] = (0, react.useState)(false);
			const [showAll, setShowAll] = (0, react.useState)(false);
			const [wrap, setWrap] = (0, react.useState)(false);
			const [filter, setFilter] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const sessionId = typeof rest.sessionId === "string" ? rest.sessionId : void 0;
			const [confirmMerge, setConfirmMerge] = (0, react.useState)(false);
			const [mergeState, setMergeState] = (0, react.useState)("idle");
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => () => {
				mounted.current = false;
			}, []);
			const load = (0, react.useCallback)(async (refresh) => {
				if (cwd === void 0 || iid === void 0 || project === void 0) return;
				setLoading(true);
				setError("");
				try {
					const detail = await loadDetail({
						cwd,
						project,
						iid
					}, { refresh });
					if (!mounted.current) return;
					setPayload(detail);
				} catch (failure) {
					if (!mounted.current) return;
					setError(failure instanceof Error ? failure.message : "加载失败");
				} finally {
					if (mounted.current) setLoading(false);
				}
			}, [
				cwd,
				iid,
				project
			]);
			(0, react.useEffect)(() => {
				load(false);
			}, [load]);
			(0, react.useEffect)(() => {
				if (payload === null || selected === null) {
					setPatch(null);
					return;
				}
				let alive = true;
				setPatchLoading(true);
				setPatchError("");
				if (cwd === void 0) {
					setPatchLoading(false);
					setPatchError("缺少工作区路径");
					return;
				}
				loadPatch({
					cwd,
					project: payload.project,
					iid: payload.mr.iid,
					path: selected
				}).then((value) => {
					if (alive) setPatch(value);
				}).catch((failure) => {
					if (alive) setPatchError(failure instanceof Error ? failure.message : "无法读取补丁");
				}).finally(() => {
					if (alive) setPatchLoading(false);
				});
				return () => {
					alive = false;
				};
			}, [
				cwd,
				payload,
				selected
			]);
			(0, react.useEffect)(() => {
				setSelected(initialPath ?? null);
				setShowAll(false);
				setNotice("");
			}, [iid, initialPath]);
			const files = payload?.files ?? [];
			const visible = filter.trim() === "" ? files : files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
			const index = selected === null ? -1 : visible.findIndex((file) => file.path === selected);
			const previous = index > 0 ? visible[index - 1] : void 0;
			const next = index >= 0 && index < visible.length - 1 ? visible[index + 1] : void 0;
			const current = index >= 0 ? visible[index] : void 0;
			const copy = async (text) => {
				try {
					await navigator.clipboard.writeText(text);
					if (mounted.current) setNotice("已复制");
				} catch {
					if (mounted.current) setNotice("复制失败");
				}
			};
			const close = () => {
				info?.tab?.actions?.close?.();
			};
			const askAgentToMerge = async () => {
				if (payload === null || sessionId === void 0) return;
				setConfirmMerge(false);
				setMergeState("sending");
				try {
					await host.mergeViaAgent({
						sessionId,
						project: payload.project,
						iid: payload.mr.iid,
						sourceBranch: payload.mr.sourceBranch,
						targetBranch: payload.mr.targetBranch,
						webUrl: payload.mr.webUrl
					});
					if (mounted.current) setMergeState("sent");
				} catch {
					if (mounted.current) setMergeState("error");
				}
			};
			if (cwd === void 0 || iid === void 0 || project === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "gli-pane gli-pane-empty",
				children: "缺少作品参数，请从对话中的 MR 卡片打开。"
			});
			if (loading && payload === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "gli-pane gli-pane-empty",
				children: "读取 MR 信息…"
			});
			if (error !== "" && payload === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "gli-pane gli-pane-empty",
				children: [
					"无法读取 MR：",
					error,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "gli-link-btn",
						onClick: () => {
							load(true);
						},
						children: "重试"
					})
				]
			});
			if (payload === null) return null;
			const mr = payload.mr;
			const status = statusLabel(mr);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "gli-pane",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "gli-pane-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-pane-top",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-tile",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMr, { size: 18 })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-pane-copy",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "gli-head-line",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-mr",
														children: ["!", mr.iid]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "gli-branch",
														children: ["→ ", mr.targetBranch]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: `gli-status gli-status-${status.tone}`,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "gli-status-dot",
															"aria-hidden": "true"
														}), status.text]
													})
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "gli-pane-title",
												children: mr.title
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "gli-pane-meta",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-num",
														children: payload.commits.length
													}),
													" 提交 ·",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "gli-num",
														children: payload.files.length
													}),
													" 文件",
													payload.identity.email !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · 你：", payload.identity.email] })
												]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "gli-pane-tools",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "gli-icon-btn",
												title: "刷新",
												"aria-label": "刷新",
												disabled: loading,
												onClick: () => {
													load(true);
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefresh, { size: 15 })
											}),
											mr.webUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												className: "gli-icon-btn",
												title: "在 GitLab 打开",
												"aria-label": "在 GitLab 打开",
												href: mr.webUrl,
												target: "_blank",
												rel: "noreferrer",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconExternal, { size: 15 })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "gli-icon-btn",
												title: "关闭",
												"aria-label": "关闭",
												onClick: close,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClose, { size: 15 })
											})
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-pane-bar",
								children: [
									host.canMergeViaAgent && sessionId !== void 0 && mr.state === "opened" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "gli-text-btn",
										disabled: mergeState === "sending" || mergeState === "sent",
										onClick: () => setConfirmMerge(true),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSpark, { size: 14 }), mergeState === "sent" ? "已发送给 Agent" : mergeState === "sending" ? "发送中…" : "让 Agent 合入"]
									}),
									mergeState === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-error-text",
										children: "消息发送失败，请重试"
									}),
									loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-muted-text",
										children: "刷新中…"
									})
								]
							}),
							confirmMerge && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-callout",
								role: "alertdialog",
								"aria-label": `确认让 Agent 合入 !${String(mr.iid)}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "gli-callout-text",
									children: [
										"确认让 Agent 合入 ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
											"!",
											mr.iid,
											" → ",
											mr.targetBranch
										] }),
										"？ 它会先重新拉取并复核闸门，任一不过就停手；这一步只会发送一条对话消息，不会直接调用 GitLab 合并。"
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "gli-callout-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										type: "button",
										variant: "outline",
										size: "sm",
										onClick: () => setConfirmMerge(false),
										children: "取消"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										type: "button",
										variant: "primary",
										size: "sm",
										onClick: () => {
											askAgentToMerge();
										},
										children: "确认发送"
									})]
								})]
							})
						]
					}),
					selected === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "gli-pane-body",
						children: [
							files.length > 30 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "gli-search",
								value: filter,
								onChange: (event) => setFilter(event.target.value),
								placeholder: "筛选文件路径",
								"aria-label": "筛选文件路径"
							}),
							visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "gli-empty",
								children: "没有匹配的文件"
							}),
							visible.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "gli-row",
								onClick: () => {
									setSelected(file.path);
									setShowAll(false);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `gli-file-letter gli-file-${file.status}`,
										children: fileLetter(file.status)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-path",
										title: file.path,
										children: file.path
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "gli-stats",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-plus",
											children: ["+", file.additions]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-minus",
											children: ["−", file.deletions]
										})]
									}),
									file.binary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-tag",
										children: "binary"
									})
								]
							}, file.path))
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "gli-pane-body",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-diff-head",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "gli-text-btn",
										onClick: () => {
											setSelected(null);
											setPatch(null);
											setShowAll(false);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconBack, { size: 14 }), "文件列表"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "gli-diff-path",
										title: selected,
										children: selected
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "gli-stats",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-plus",
											children: ["+", current?.additions ?? patch?.additions ?? 0]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "gli-minus",
											children: ["−", current?.deletions ?? patch?.deletions ?? 0]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "gli-spacer" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: wrap ? "gli-text-btn gli-text-btn-on" : "gli-text-btn",
										"aria-pressed": wrap,
										title: wrap ? "不换行" : "自动换行",
										onClick: () => setWrap((value) => !value),
										children: "换行"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "gli-icon-btn",
										title: "复制路径",
										"aria-label": "复制路径",
										onClick: () => {
											copy(selected);
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCopy, { size: 15 })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "gli-icon-btn",
										title: "上一个文件",
										"aria-label": "上一个文件",
										disabled: previous === void 0,
										onClick: () => {
											if (previous !== void 0) {
												setSelected(previous.path);
												setShowAll(false);
											}
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconUp, { size: 15 })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "gli-icon-btn",
										title: "下一个文件",
										"aria-label": "下一个文件",
										disabled: next === void 0,
										onClick: () => {
											if (next !== void 0) {
												setSelected(next.path);
												setShowAll(false);
											}
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDown, { size: 15 })
									})
								]
							}),
							notice !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "gli-note",
								children: notice
							}),
							patchLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "gli-empty",
								children: "读取补丁…"
							}),
							patchError !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "gli-error-text",
								children: patchError
							}),
							patch !== null && !patchLoading && (patch.unavailable || patch.patch === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "gli-empty",
								children: [patch.binary ? "二进制文件，无文本 diff。" : patch.status === "renamed" && patch.additions === 0 && patch.deletions === 0 ? "纯重命名，文件内容没有改动。" : "补丁过大或不可用，请在 GitLab 中查看。", mr.webUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: "gli-link-btn",
									href: `${mr.webUrl}/diffs`,
									target: "_blank",
									rel: "noreferrer",
									children: "在 GitLab 查看 diff"
								})]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									className: wrap ? "gli-diff gli-diff-wrap" : "gli-diff",
									tabIndex: 0,
									"aria-label": `${selected} 的差异`,
									children: (showAll ? patch.patch.split("\n") : patch.patch.split("\n").slice(0, SHOWN_DIFF_LINES)).map((line, lineIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: `gli-diff-line ${diffLineClass(line)}`,
										children: line === "" ? " " : line
									}, lineIndex))
								}),
								!showAll && patch.patch.split("\n").length > SHOWN_DIFF_LINES && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "gli-text-btn",
									onClick: () => setShowAll(true),
									children: [
										"显示全部 ",
										patch.patch.split("\n").length,
										" 行"
									]
								}),
								patch.truncated && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "gli-note gli-note-muted",
									children: "补丁过大，仅显示前 200,000 字符。"
								})
							] }))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: "gli-pane-foot",
						children: [mr.hasConflicts && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "gli-status gli-status-bad",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "gli-status-dot",
								"aria-hidden": "true"
							}), "conflict"]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "gli-time",
							children: ["数据 ", formatDate(payload.fetchedAt)]
						})]
					})
				]
			});
		}
		/**
		* Mount the three surfaces. The pane is mounted only when the sidebar-right
		* services exist; the card and dock still work in a profile without them.
		*/
		function installMrSurfaces(ctx, hostServices) {
			const sidebarRight = hostServices.sidebarRight;
			const sidebarRightTabs = hostServices.sidebarRightTabs;
			const canOpenReview = typeof sidebarRight?.openTab === "function" && typeof sidebarRightTabs?.register === "function";
			const sessions = ctx.sessions;
			const host = {
				canOpenReview,
				canMergeViaAgent: typeof sessions?.using === "function",
				openReview: (input) => {
					if (!canOpenReview) return;
					try {
						sidebarRight?.openTab?.(MR_TAB_KIND, { params: input });
					} catch {}
				},
				mergeViaAgent: async (input) => {
					if (sessions?.using === void 0) throw new Error("会话服务不可用");
					if (input.sessionId === "") throw new Error("缺少会话身份");
					const text = mergePrompt(input);
					await sessions.using(input.sessionId, {
						source: "dsh-gitlab-mr-review",
						signal: new AbortController().signal
					}, async (reference) => {
						await reference.ready;
						const session = reference.binding?.session;
						if (session === void 0) throw new Error("会话尚未就绪");
						const submission = session.beginSubmission({
							mode: "queue",
							text,
							attachments: []
						});
						try {
							const result = await session.prompt([{
								type: "text",
								text
							}], "queue", new AbortController().signal, submission.requestId);
							if (result !== void 0 && result !== null && result.ok === false) throw new Error(typeof result.error?.message === "string" ? result.error.message : "提交失败");
						} catch (error) {
							try {
								submission.abandon();
							} catch {}
							throw error;
						}
					});
				}
			};
			const slots = ctx.slots;
			slots.inject("conversation.chat.turnTail", () => slots.register({
				name: "conversation.chat.turnTail",
				id: MR_TAB_ID,
				order: 20
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MrTurnTail, {
				...props,
				host
			})));
			slots.inject("conversation.composer.dock", () => slots.register({
				name: "conversation.composer.dock",
				id: MR_TAB_ID,
				order: 20
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MrDock, {
				...props,
				host
			})));
			if (canOpenReview) {
				ctx.effect?.(() => {
					const remove = sidebarRightTabs?.register?.({
						id: MR_TAB_ID,
						kind: MR_TAB_KIND,
						priority: "extension",
						title: () => "MR 审查"
					});
					return () => {
						if (typeof remove === "function") remove();
					};
				}, "dsh-gitlab: MR review tab");
				slots.inject("sidebar.right.pane.tab", () => slots.register({
					name: "sidebar.right.pane.tab",
					key: MR_TAB_ID
				}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MrReviewPane, {
					...props,
					host
				})));
			}
			ctx.effect?.(() => {
				if (typeof document === "undefined") return () => {};
				const style = document.createElement("style");
				style.dataset.plugin = "@lim324/dsh-gitlab/mr";
				style.textContent = MR_STYLES;
				document.head.append(style);
				return () => style.remove();
			}, "dsh-gitlab: MR surfaces styles");
			return host;
		}
		/** Scoped styles; only `.gli-*` selectors, all values from DSH tokens. */
		const MR_STYLES = `
/* MR review surfaces — same visual language as the native changed-files card:
   hairline border, layer-1 surface, 13/20 title, 10/16 tertiary stats, 36/44px rows. */
.gli-tail{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.gli-card{container-type:inline-size;position:relative;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;min-width:0}
.gli-card-head{display:flex;align-items:flex-start;gap:2px;padding:10px 10px 8px 12px;transition:background-color .12s ease}
.gli-card-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gli-expand{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:8px}
.gli-expand:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-tile{width:32px;height:32px;flex:none;display:grid;place-items:center;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);color:var(--dsw-alias-label-secondary)}
.gli-head-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.gli-head-line{display:flex;align-items:center;gap:8px;min-width:0}
.gli-mr{font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:13px;line-height:20px;font-weight:600;letter-spacing:.01em;flex:none}
.gli-branch{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.gli-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.gli-status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.gli-status-ok{color:var(--dsw-alias-state-success-primary)}
.gli-status-warn{color:var(--dsw-alias-state-warning-primary)}
.gli-status-bad{color:var(--dsw-alias-state-error-primary)}
.gli-status-muted{color:var(--dsw-alias-label-tertiary)}
.gli-chevron{display:inline-flex;align-items:center;justify-content:center;margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.gli-chevron[data-open=true]{transform:rotate(180deg)}
.gli-card-title{font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-num{font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-sep{color:var(--dsw-alias-label-tertiary)}
.gli-counts{display:inline-flex;align-items:center;gap:5px;flex:none}
.gli-plus{color:var(--dsw-alias-state-success-primary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-minus{color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-warn-line{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warning-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-ok-line{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-body{border-top:0.5px solid var(--dsw-alias-border-l2);padding:8px 0 0}
.gli-body-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex-wrap:wrap}
.gli-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}
.gli-seg-item{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;min-height:26px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.gli-seg-item[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 0.5px var(--dsw-alias-border-l1)}
.gli-seg-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-text-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:6px 6px;min-height:30px;border-radius:6px;cursor:pointer;text-decoration:none}
.gli-text-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.gli-text-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-text-btn:disabled{opacity:.45;cursor:default}
.gli-text-btn-on{color:var(--dsw-alias-state-warning-primary)}
.gli-link-btn{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 2px;min-height:26px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.gli-link-btn:hover{color:var(--dsw-alias-label-primary)}
.gli-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:none}
.gli-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gli-icon-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-icon-btn:disabled{opacity:.35;cursor:default}
.gli-list{display:flex;flex-direction:column}
.gli-row-wrap{display:flex;flex-direction:column}
.gli-row-wrap + .gli-row-wrap{border-top:0.5px solid var(--dsw-alias-border-l1)}
.gli-row{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:6px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box;min-width:0}
.gli-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.gli-row:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-row:disabled{opacity:.7;cursor:default}
.gli-author{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.gli-author::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.gli-author-other{color:var(--dsw-alias-state-warning-primary)}
.gli-author-unknown{color:var(--dsw-alias-label-tertiary)}
.gli-sha{flex:none;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.gli-row-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.gli-row-title{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-row-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap}
.gli-sub-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-tag{flex:none;font-size:10px;line-height:15px;padding:0 5px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace))}
.gli-new{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warning-primary);flex:none}
.gli-drill{margin:0 12px 8px 60px;padding:6px 0 4px;border-top:0.5px dashed var(--dsw-alias-border-l1)}
.gli-drill-title{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}
.gli-drill-row{display:flex;align-items:center;gap:8px;min-height:28px;font-size:12px}
.gli-file-letter{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;line-height:16px;font-weight:600}
.gli-file-added{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.gli-file-modified{color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 12%,transparent)}
.gli-file-deleted{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.gli-file-renamed{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.gli-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.gli-stats{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-filter-chip{display:flex;align-items:center;gap:8px;padding:4px 12px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-empty{padding:10px 12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.gli-note{display:flex;align-items:center;gap:8px;padding:2px 12px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warning-primary)}
.gli-note-muted{color:var(--dsw-alias-label-tertiary)}
.gli-muted-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-error-text{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.gli-error-card{padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.gli-callout{display:flex;flex-direction:column;gap:6px;margin:8px 12px;padding:8px 10px;border-left:3px solid var(--dsw-alias-state-warning-primary);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.gli-callout-text{display:block}
.gli-callout-actions{display:flex;gap:8px;flex-wrap:wrap}
.gli-foot{display:flex;align-items:center;gap:2px;flex-wrap:wrap;border-top:0.5px solid var(--dsw-alias-border-l2);padding:4px 8px}
.gli-time{margin-left:auto;padding-right:4px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* composer dock: one ambient line, no bordered buttons */
.gli-dock{display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.gli-dock::-webkit-scrollbar{display:none}
.gli-dock-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.gli-dock-branch{flex:none;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;color:var(--dsw-alias-label-tertiary)}
.gli-dock-item{flex:none;appearance:none;display:inline-flex;align-items:center;gap:4px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:3px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}
.gli-dock-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gli-dock-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-dock-item:disabled{opacity:.6;cursor:default}
.gli-dock-item .gli-mr{font-size:11px;line-height:16px;font-weight:500}
.gli-dock-target{color:var(--dsw-alias-label-tertiary)}
/* review pane */
.gli-pane{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.gli-pane-empty{padding:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.gli-pane-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:12px 14px 8px}
.gli-pane-top{display:flex;align-items:flex-start;gap:10px}
.gli-pane-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.gli-pane-title{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-pane-meta{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.gli-pane-tools{display:flex;align-items:center;gap:2px;flex:none}
.gli-pane-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.gli-pane-body{flex:1;min-height:0;overflow:auto;padding:0 0 12px}
.gli-search{width:calc(100% - 24px);min-height:32px;margin:8px 12px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;box-sizing:border-box}
.gli-search:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-diff-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));border-bottom:0.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.gli-diff-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gli-diff{margin:0;padding:6px 0 24px;overflow:auto;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block,12px/1.6 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace));white-space:pre;tab-size:2}
.gli-diff-line{box-sizing:border-box;min-height:1lh;padding:0 22px;white-space:pre}
.gli-diff-wrap,.gli-diff-wrap .gli-diff-line{white-space:pre-wrap;overflow-wrap:anywhere}
.gli-diff-add{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-code-diff-added,color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}
.gli-diff-del{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-code-diff-deleted,color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}
.gli-diff-hunk{color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 7%,transparent)}
.gli-diff-meta{color:var(--dsw-alias-label-tertiary)}
.gli-spacer{flex:1}
.gli-pane-foot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:10px}
.gli-pane-foot .gli-time{margin-left:auto}
@container (max-width: 420px){
  .gli-card-head{padding:8px 8px 6px 10px}
  .gli-tile{width:26px;height:26px;border-radius:8px}
  .gli-head-copy{gap:0}
  .gli-card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden;line-height:19px}
  .gli-card-meta{gap:5px}
  .gli-warn-line,.gli-ok-line{white-space:normal}
  .gli-body-bar{padding:0 10px 6px}
  .gli-seg{width:100%}
  .gli-seg-item{flex:1;justify-content:center}
  .gli-row{min-height:44px;padding:7px 10px}
  .gli-commit .gli-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden;line-height:17px}
  .gli-tag{align-self:flex-start;margin-top:1px}
  .gli-foot{padding:4px 6px}
  .gli-foot .gli-text-btn{flex:1;justify-content:center;min-height:36px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}
  .gli-time{display:none}
  .gli-drill{margin:0 10px 8px}
}
@container (max-width: 360px){
  .gli-tile{display:none}
  .gli-card-head{padding-left:10px}
}
@media (max-width:640px){
  .gli-pane-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden}
  .gli-pane-tools .gli-icon-btn{width:32px;height:32px}
  .gli-pane-head{padding:10px 12px 6px}
  .gli-diff-head{padding:6px 10px;gap:6px}
  .gli-diff-head .gli-stats{display:none}
  .gli-diff{font-size:11.5px}
  .gli-dock-branch{max-width:100px}
}
@media (pointer:coarse){.gli-row,.gli-drill-row{min-height:44px}.gli-icon-btn{width:32px;height:32px}.gli-text-btn{min-height:36px}}
@media (max-width:640px){
  .gli-card-head{padding:9px 8px 7px 10px}
  .gli-tile{width:28px;height:28px;border-radius:9px}
  .gli-head-line{gap:6px}
  .gli-pane-head{padding:10px 12px 6px}
  .gli-pane-body{padding-bottom:8px}
  .gli-diff-line{padding:0 14px}
  .gli-drill{margin-left:12px}
}
@media (prefers-reduced-motion:reduce){.gli-card-head,.gli-chevron{transition:none}}
`;
		//#endregion
		//#region src/client/index.tsx
		/**
		* Client half: a conversation-pane tab (the `conversation.view` seat, beside
		* Chat and Trajectory) showing the pipelines and open MRs of the workspace
		* the open session belongs to. The tab is session-scoped: its sessionId
		* selects the workspace through the workspaces feed, and only that
		* workspace's status is fetched from the host (`/gitlab/status?workspaceId=`)
		* on a 10-second cadence. All requests are same-origin, so the Web session
		* cookie authenticates them. The surface is built from the platform's
		* UI primitives and `--dsw-*` design tokens.
		* @module @lim324/dsh-gitlab/client
		*/
		/** Stable Cordis plugin name (client half). */
		const name = "dsh-gitlab";
		/** Client services required before the tab can mount. */
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"sidebarRight",
			"sidebarRightTabs"
		];
		/** Poll cadence for the host status route. */
		const POLL_MS = 1e4;
		/**
		* Resolve the workspace a session belongs to: the first workspace whose
		* sessionIds contain the session. Undefined when the session belongs to no
		* workspace.
		* @param sessionId - the open session.
		* @param workspaces - the workspaces feed rows.
		* @returns the owning workspace id, or undefined.
		*/
		function findWorkspaceId(sessionId, workspaces) {
			if (sessionId === void 0) return void 0;
			return workspaces.find((candidate) => candidate.sessionIds.includes(sessionId))?.workspaceId;
		}
		/** Read the status row of one workspace. */
		async function fetchStatus(workspaceId) {
			try {
				const res = await fetch(`/gitlab/status?workspaceId=${encodeURIComponent(workspaceId)}`);
				if (res.ok) return {
					status: await res.json(),
					error: ""
				};
				return { error: `host answered ${String(res.status)}` };
			} catch {
				return { error: "cannot reach the GitLab surface" };
			}
		}
		/** Submit one MR action and report the outcome. */
		async function submitAction(op, iid, project, extras) {
			const payload = {
				op,
				iid,
				project
			};
			if (extras?.title !== void 0) payload.title = extras.title;
			if (extras?.sourceBranch !== void 0) payload.sourceBranch = extras.sourceBranch;
			if (extras?.targetBranch !== void 0) payload.targetBranch = extras.targetBranch;
			const res = await fetch("/gitlab/actions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (res.ok) {
				const data = await res.json();
				return {
					ok: true,
					note: data.iid !== void 0 ? `MR !${data.iid} created` : "done"
				};
			}
			return {
				ok: false,
				note: res.status === 401 ? "token required" : await res.text()
			};
		}
		/** Map one GitLab status string to the platform's four-state semantic. */
		function dotState(status) {
			if (status === "success") return "done";
			if (status === "failed" || status === "canceled") return "error";
			if (status === "skipped" || status === "manual") return "warning";
			return "ongoing";
		}
		const style = {
			root: {
				padding: "16px 20px",
				boxSizing: "border-box",
				height: "100%",
				overflowY: "auto",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 13
			},
			header: {
				fontWeight: 600,
				fontSize: 15,
				margin: "0 0 4px"
			},
			sub: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				margin: "0 0 12px"
			},
			section: {
				fontWeight: 600,
				fontSize: 11,
				textTransform: "uppercase",
				letterSpacing: ".04em",
				color: "var(--dsw-alias-label-tertiary)",
				margin: "14px 0 4px"
			},
			error: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				margin: "0 0 8px"
			},
			note: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				marginTop: 8
			},
			meta: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 11
			},
			stages: {
				display: "flex",
				flexDirection: "row",
				flexWrap: "wrap",
				gap: 8,
				alignItems: "flex-start",
				padding: "6px 0 10px"
			},
			stage: {
				minWidth: 140,
				border: "1px solid var(--dsw-alias-border-low)",
				borderRadius: 8,
				padding: "6px 8px",
				boxSizing: "border-box"
			},
			stageName: {
				fontWeight: 600,
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				marginBottom: 4
			},
			job: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "3px 0",
				fontSize: 12
			},
			mrRow: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 0",
				borderTop: "1px solid var(--dsw-alias-border-low)"
			},
			createBar: {
				display: "flex",
				gap: 8,
				marginBottom: 6,
				flexWrap: "wrap",
				alignItems: "center"
			},
			select: {
				padding: "5px 8px",
				border: "1px solid var(--dsw-alias-border-low)",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-low)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12
			},
			link: {
				color: "var(--dsw-alias-label-primary)",
				textDecoration: "none"
			}
		};
		/** The GitLab tab body: pipelines and open MRs of the open session's workspace. */
		function GitlabView({ sessionId, useWorkspaces }) {
			const workspaceId = findWorkspaceId(sessionId, useWorkspaces((state) => state.items));
			const [status, setStatus] = (0, react.useState)();
			const [fetchError, setFetchError] = (0, react.useState)(null);
			const [expandedPipeline, setExpandedPipeline] = (0, react.useState)(null);
			const [actionToast, setActionToast] = (0, react.useState)(null);
			const [busyOp, setBusyOp] = (0, react.useState)(null);
			const [mrTitle, setMrTitle] = (0, react.useState)("");
			const [sourceBranch, setSourceBranch] = (0, react.useState)(null);
			const [targetBranch, setTargetBranch] = (0, react.useState)(null);
			const busy = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (status === void 0) return;
				setSourceBranch((current) => current ?? status.currentBranch ?? status.branches[0] ?? null);
				setTargetBranch((current) => current ?? status.defaultBranch ?? status.branches[0] ?? null);
			}, [status]);
			(0, react.useEffect)(() => {
				let alive = true;
				if (workspaceId === void 0) {
					setStatus(void 0);
					setFetchError(null);
					return;
				}
				const poll = async () => {
					const outcome = await fetchStatus(workspaceId);
					if (!alive) return;
					if (outcome.status !== void 0) {
						setStatus(outcome.status);
						setFetchError(null);
					} else setFetchError(outcome.error);
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [workspaceId]);
			const refreshAfterAction = (0, react.useCallback)(async () => {
				if (workspaceId === void 0) return;
				const refreshed = await fetchStatus(workspaceId);
				if (refreshed.status !== void 0) {
					setStatus(refreshed.status);
					setFetchError(null);
				} else setFetchError(refreshed.error);
			}, [workspaceId]);
			const dismissToast = (0, react.useCallback)(() => {
				setActionToast(null);
			}, []);
			const showToast = (0, react.useCallback)((text) => {
				setActionToast((previous) => ({
					text,
					seq: (previous?.seq ?? 0) + 1
				}));
			}, []);
			const runAction = (0, react.useCallback)(async (op, iid, project) => {
				if (busy.current || workspaceId === void 0) return;
				busy.current = true;
				setBusyOp(`${op} MR !${iid}`);
				try {
					const outcome = await submitAction(op, iid, project);
					showToast(`${op} MR !${iid}: ${outcome.note}`);
					await refreshAfterAction();
				} catch {
					showToast("action failed");
				} finally {
					busy.current = false;
					setBusyOp(null);
				}
			}, [
				workspaceId,
				refreshAfterAction,
				showToast
			]);
			const runCreateMr = (0, react.useCallback)(async (project) => {
				if (busy.current || workspaceId === void 0) return;
				busy.current = true;
				setBusyOp("create MR");
				try {
					const outcome = await submitAction("create-mr", 0, project, {
						title: mrTitle,
						sourceBranch: sourceBranch ?? void 0,
						targetBranch: targetBranch ?? void 0
					});
					showToast(outcome.note);
					await refreshAfterAction();
				} catch {
					showToast("action failed");
				} finally {
					busy.current = false;
					setBusyOp(null);
				}
			}, [
				workspaceId,
				mrTitle,
				sourceBranch,
				targetBranch,
				refreshAfterAction,
				showToast
			]);
			if (workspaceId === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style.root,
				children: "This session has no workspace, or the workspace is not a GitLab repository."
			});
			if (status === void 0 && fetchError !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style.root,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					style: style.error,
					children: ["GitLab status unavailable: ", fetchError]
				})
			});
			if (status === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style.root,
				children: "Loading…"
			});
			if (!status.gitlab) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: style.root,
				children: "This workspace is not a GitLab repository."
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: style.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: style.header,
						children: "GitLab CI/CD"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: style.sub,
						children: [status.title, !status.authed ? " · read-only (no token)" : ""]
					}),
					status.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: style.error,
						children: ["GitLab API error: ", status.error]
					}) : null,
					fetchError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: style.error,
						children: ["Showing stale data — refresh failed: ", fetchError]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: style.section,
						children: "Pipelines"
					}),
					status.pipelines.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: style.meta,
						children: "none"
					}) : status.pipelines.map((pipeline) => {
						const expanded = expandedPipeline === pipeline.id;
						const stages = [];
						for (const job of pipeline.jobs) {
							const last = stages[stages.length - 1];
							if (last !== void 0 && last.name === job.stage) last.jobs.push(job);
							else stages.push({
								name: job.stage,
								jobs: [job]
							});
						}
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: dotState(pipeline.status) }),
							title: `${pipeline.status.replace(/_/g, " ")} · ${pipeline.ref}`,
							collapsedContent: pipeline.commit !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...style.meta,
									marginLeft: 10
								},
								children: [pipeline.commit.title, pipeline.commit.authorName !== null ? ` · ${pipeline.commit.authorName}` : ""]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...style.meta,
									marginLeft: 10
								},
								children: pipeline.sha.slice(0, 8)
							}),
							keepContentWhenOpen: true,
							open: expanded,
							expandable: true,
							onToggle: () => setExpandedPipeline(expanded ? null : pipeline.id),
							expandOnRowClick: true,
							children: pipeline.jobs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: style.meta,
								children: "no jobs"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: style.stages,
								children: stages.map((stage) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: style.stage,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: style.stageName,
										children: stage.name
									}), stage.jobs.map((job) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: style.job,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
												state: dotState(job.status),
												size: 10
											}),
											job.webUrl !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												style: style.link,
												href: job.webUrl,
												target: "_blank",
												rel: "noreferrer",
												title: `${job.name} · ${job.status}`,
												children: job.name
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: job.name }),
											job.durationSeconds !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													...style.meta,
													marginLeft: "auto"
												},
												children: [Math.round(job.durationSeconds), "s"]
											}) : null
										]
									}, job.id))]
								}, stage.name))
							})
						}, pipeline.id);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: style.section,
						children: "Open merge requests"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style.createBar,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								style: style.select,
								value: sourceBranch ?? "",
								onChange: (event) => setSourceBranch(event.target.value),
								disabled: !status.authed,
								title: "source branch",
								children: status.branches.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: name,
									children: name
								}, name))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: style.meta,
								children: "→"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								style: style.select,
								value: targetBranch ?? "",
								onChange: (event) => setTargetBranch(event.target.value),
								disabled: !status.authed,
								title: "target branch",
								children: status.branches.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: name,
									children: name
								}, name))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								style: {
									flex: 1,
									minWidth: 140
								},
								placeholder: "MR title (optional)",
								value: mrTitle,
								onChange: (event) => setMrTitle(event.target.value),
								disabled: !status.authed
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: !status.authed || busyOp !== null,
								onClick: () => void runCreateMr(status.project),
								children: busyOp === "create MR" ? "Creating…" : "Create MR"
							})
						]
					}),
					status.mrs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: style.meta,
						children: "none"
					}) : status.mrs.map((mr) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style.mrRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Pill, { children: ["!", mr.iid] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: 1,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								children: mr.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: style.meta,
								children: [
									mr.sourceBranch,
									" → ",
									mr.targetBranch
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: !status.authed || busyOp !== null,
								onClick: () => void runAction("approve", mr.iid, status.project),
								children: busyOp === `approve MR !${mr.iid}` ? "Approving…" : "Approve"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: !status.authed || busyOp !== null,
								onClick: () => void runAction("merge", mr.iid, status.project),
								children: busyOp === `merge MR !${mr.iid}` ? "Merging…" : "Merge"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: !status.authed || busyOp !== null,
								onClick: () => void runAction("close", mr.iid, status.project),
								children: busyOp === `close MR !${mr.iid}` ? "Closing…" : "Close"
							})
						]
					}, mr.iid)),
					busyOp !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: style.note,
						children: [busyOp, " …"]
					}) : null,
					actionToast !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: actionToast.text,
						onDone: dismissToast
					}, actionToast.seq) : null
				]
			});
		}
		/** Read the saved-token state through the plugin's own fenced route. */
		async function fetchGitlabSettings() {
			try {
				const res = await fetch("/gitlab/settings");
				if (res.ok) return await res.json();
				return null;
			} catch {
				return null;
			}
		}
		/** Write or clear a token (optionally per host); returns the fresh view and flags a revision conflict. */
		async function writeGitlabSettings(body) {
			try {
				const res = await fetch("/gitlab/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (res.ok) return {
					ok: true,
					conflict: false,
					view: await res.json()
				};
				return {
					ok: false,
					conflict: res.status === 409,
					view: null
				};
			} catch {
				return {
					ok: false,
					conflict: false,
					view: null
				};
			}
		}
		/** The Settings panel's GitLab page: edit the tokens the host half uses. */
		function GitlabTokenForm() {
			const [view, setView] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)("");
			const [hostDraft, setHostDraft] = (0, react.useState)("");
			const [hostTokenDraft, setHostTokenDraft] = (0, react.useState)("");
			const [busyOp, setBusyOp] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				fetchGitlabSettings().then((fresh) => {
					if (alive) setView(fresh);
				});
				return () => {
					alive = false;
				};
			}, []);
			const unavailable = view?.available === false;
			const readOnly = view !== null && view.available && !view.writable;
			const disabled = view === null || unavailable || readOnly || busyOp !== null;
			const settle = async (outcome, successNote) => {
				if (outcome.ok && outcome.view !== null) {
					setView(outcome.view);
					setNote(successNote);
				} else {
					setNote(outcome.conflict ? "settings changed elsewhere — reloaded, try again" : "save failed");
					if (outcome.conflict) setView(await fetchGitlabSettings());
				}
				setBusyOp(null);
				return outcome.ok && outcome.view !== null;
			};
			const save = async () => {
				if (draft === "" || view === null) return;
				setBusyOp("save");
				setNote(null);
				if (await settle(await writeGitlabSettings({
					token: draft,
					expectedRevision: view.revision
				}), "saved — the GitLab tab now uses this token")) setDraft("");
			};
			const clear = async () => {
				if (view === null) return;
				setBusyOp("clear");
				setNote(null);
				await settle(await writeGitlabSettings({
					clear: true,
					expectedRevision: view.revision
				}), "cleared — back to plugin config / environment");
			};
			const saveHost = async () => {
				if (hostDraft === "" || hostTokenDraft === "" || view === null) return;
				setBusyOp("saveHost");
				setNote(null);
				if (await settle(await writeGitlabSettings({
					host: hostDraft,
					token: hostTokenDraft,
					expectedRevision: view.revision
				}), `saved — ${hostDraft} now uses this token`)) setHostTokenDraft("");
			};
			const clearHost = async (host) => {
				if (view === null) return;
				setBusyOp(`clearHost:${host}`);
				setNote(null);
				await settle(await writeGitlabSettings({
					host,
					clear: true,
					expectedRevision: view.revision
				}), `cleared — ${host} falls back to the default token`);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.sub,
					children: "Access tokens the host uses for pipeline and merge-request access. Empty falls back to the plugin config or the GITLAB_TOKEN environment. The browser never reads a saved token back."
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: style.createBar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							style: {
								flex: 1,
								minWidth: 200
							},
							type: "password",
							placeholder: "personal access token",
							value: draft,
							onChange: (event) => setDraft(event.target.value),
							disabled
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: disabled || draft === "",
							onClick: () => void save(),
							children: busyOp === "save" ? "Saving…" : "Save"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: disabled || !view?.tokenSet,
							onClick: () => void clear(),
							children: busyOp === "clear" ? "Clearing…" : "Clear"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.meta,
					children: view?.tokenSet === true ? "A default token is saved." : "No default token saved."
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: style.section,
					children: "Per-host tokens"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.sub,
					children: "Keyed by the workspace remote's host (e.g. gitlab.com); a matching host overrides the default token for that host."
				}),
				view?.hostTokens.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.meta,
					children: "none"
				}) : view?.hostTokens.map((host) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: style.mrRow,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, { children: "saved" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: 1,
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: host
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled,
							onClick: () => void clearHost(host),
							children: busyOp === `clearHost:${host}` ? "Clearing…" : "Clear"
						})
					]
				}, host)),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: style.createBar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							style: {
								flex: 1,
								minWidth: 140
							},
							placeholder: "host (gitlab.com)",
							value: hostDraft,
							onChange: (event) => setHostDraft(event.target.value),
							disabled
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							style: {
								flex: 1,
								minWidth: 200
							},
							type: "password",
							placeholder: "token for this host",
							value: hostTokenDraft,
							onChange: (event) => setHostTokenDraft(event.target.value),
							disabled
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: disabled || hostDraft === "" || hostTokenDraft === "",
							onClick: () => void saveHost(),
							children: busyOp === "saveHost" ? "Adding…" : "Add"
						})
					]
				}),
				unavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.error,
					children: "The settings service is not mounted in this deployment."
				}) : null,
				!unavailable && readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.error,
					children: "The settings document is read-only here."
				}) : null,
				note !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.note,
					children: note
				}) : null
			] });
		}
		/** Read the skills status through the plugin's own fenced route. */
		async function fetchSkillStatus() {
			try {
				const res = await fetch("/gitlab/skills/status");
				if (res.ok) return await res.json();
				return null;
			} catch {
				return null;
			}
		}
		/** POST one skills-management operation; returns whether the host accepted it. */
		async function postSkills(path, body) {
			try {
				return (await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				})).ok;
			} catch {
				return false;
			}
		}
		/** The Settings panel's GitLab Skills page: configure skill sources, sync a group's repositories locally, and drop local checkouts. */
		function GitlabSkillsPanel() {
			const [status, setStatus] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			const [newId, setNewId] = (0, react.useState)("");
			const [newGroup, setNewGroup] = (0, react.useState)("");
			const load = (0, react.useCallback)(async () => {
				const fresh = await fetchSkillStatus();
				if (fresh === null) setLoadError("cannot reach the skills status route");
				else {
					setStatus(fresh);
					setLoadError(null);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const sync = async (sourceId) => {
				setBusy(`sync:${sourceId}`);
				setNote(null);
				if (await postSkills("/gitlab/skills/pull", { sourceId })) {
					setNote(`synced ${sourceId}`);
					await load();
				} else setNote("sync failed");
				setBusy(null);
			};
			const remove = async (sourceId, repo) => {
				setBusy(`remove:${sourceId}:${repo}`);
				setNote(null);
				if (await postSkills("/gitlab/skills/remove", {
					sourceId,
					repo
				})) {
					setNote(`removed local checkout of ${repo}`);
					await load();
				} else setNote("remove failed");
				setBusy(null);
			};
			const pullRepo = async (sourceId, repo) => {
				setBusy(`pull:${sourceId}:${repo}`);
				setNote(null);
				if (await postSkills("/gitlab/skills/pull", {
					sourceId,
					repo
				})) {
					setNote(`pulled ${repo}`);
					await load();
				} else setNote("pull failed");
				setBusy(null);
			};
			const saveSources = async (next) => {
				if ((await fetch("/gitlab/skills/sources", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sources: next,
						expectedRevision: status?.revision
					})
				})).ok) {
					await load();
					return true;
				}
				return false;
			};
			const addSource = async () => {
				const id = newId.trim();
				const group = newGroup.trim();
				if (id === "" || group === "" || status === null) return;
				setBusy("add");
				setNote(null);
				if (await saveSources([...status.sources, {
					id,
					group,
					repos: []
				}])) {
					setNote(`added source ${id}`);
					setNewId("");
					setNewGroup("");
				} else setNote("add source failed");
				setBusy(null);
			};
			const removeSource = async (id) => {
				if (status === null) return;
				setBusy(`removeSource:${id}`);
				setNote(null);
				if (await saveSources(status.sources.filter((source) => source.id !== id))) setNote(`removed source ${id}`);
				else setNote("remove source failed");
				setBusy(null);
			};
			if (status === null && loadError !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: style.error,
				children: loadError
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: style.sub,
				children: "Skill sync needs the host route; check that the plugin is running and reachable."
			})] });
			if (status === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: style.sub,
				children: "loading…"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.sub,
					children: "Each repository under a configured group is one skill (a root SKILL.md). Add a source to list its remote repositories, then clone them individually, or use Sync to pull the whole group."
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: style.section,
					children: "Add source"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: style.createBar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							style: {
								flex: 1,
								minWidth: 120
							},
							placeholder: "source id",
							value: newId,
							onChange: (event) => setNewId(event.target.value),
							disabled: busy !== null
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							style: {
								flex: 1,
								minWidth: 180
							},
							placeholder: "group (org/skills)",
							value: newGroup,
							onChange: (event) => setNewGroup(event.target.value),
							disabled: busy !== null
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: busy !== null || newId.trim() === "" || newGroup.trim() === "",
							onClick: () => void addSource(),
							children: busy === "add" ? "Adding…" : "Add"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: style.section,
					children: "Sources"
				}),
				status.sources.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.meta,
					children: "No skill sources configured."
				}) : status.sources.map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: 16 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...style.mrRow,
							borderTop: "none"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: 1,
									fontWeight: 600,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								children: source.id
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: style.meta,
								children: source.group
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: busy !== null,
								onClick: () => void sync(source.id),
								children: busy === `sync:${source.id}` ? "Syncing…" : "Sync"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: busy !== null,
								onClick: () => void removeSource(source.id),
								children: busy === `removeSource:${source.id}` ? "Removing…" : "Remove"
							})
						]
					}), source.repos.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: style.meta,
						children: "no repositories"
					}) : source.repos.map((repo) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style.mrRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, { children: repo.pulled ? "pulled" : "remote" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									flex: 1,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								children: repo.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy !== null,
								onClick: () => void pullRepo(source.id, repo.name),
								children: busy === `pull:${source.id}:${repo.name}` ? "Pulling…" : repo.pulled ? "Pull" : "Clone"
							}),
							repo.pulled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: busy !== null,
								onClick: () => void remove(source.id, repo.name),
								children: busy === `remove:${source.id}:${repo.name}` ? "Removing…" : "Remove local"
							}) : null
						]
					}, repo.name))]
				}, source.id)),
				note !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: style.note,
					children: note
				}) : null
			] });
		}
		/** The combined Settings panel section: access tokens plus skill sources. */
		function GitlabSettingsPanel() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: style.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: style.header,
						children: "GitLab"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: style.section,
						children: "Access token"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GitlabTokenForm, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: style.section,
						children: "Skill sources"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GitlabSkillsPanel, {})
				]
			});
		}
		/**
		* Mount the GitLab tab into the conversation view ring, beside Chat and
		* Trajectory. The tab appears whenever a session is open.
		* @param ctx - client context carrying the slot registry.
		*/
		function apply(ctx) {
			installMrSurfaces(ctx, {
				sidebarRight: ctx.sidebarRight,
				sidebarRightTabs: ctx.sidebarRightTabs
			});
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "gitlab",
				order: 20,
				label: () => "GitLab"
			}, GitlabView));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "gitlab",
				order: 30,
				label: () => "GitLab"
			}, GitlabSettingsPanel));
		}
		//#endregion
		exports.apply = apply;
		exports.findWorkspaceId = findWorkspaceId;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
