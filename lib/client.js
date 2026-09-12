window.__ModuleLoader__.load({
	id: "@lim324/dsh-gitlab",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
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
			"workspaces"
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
