/**
 * dsh-browser-use — client half.
 *
 * Two UI contributions:
 *   1. a "浏览器控制 / Browser Control" settings section (master switch,
 *      certificate toggle, cache/data clearing);
 *   2. a docked embedded browser panel: a button in the conversation
 *      header toggles a right-docked live browser pane (resizable) with a
 *      tab bar, CDP screencast live view, and click / wheel / keyboard
 *      forwarding straight to the page. When the AI opens or navigates a
 *      page, the pane auto-expands. The managed browser
 *      uses a dedicated throw-away profile and is never signed into any
 *      account.
 *
 * All colors ride the host's --dsw-* design tokens so everything matches both
 * themes.
 */

window.__ModuleLoader__.load({
	id: "dsh-browser-use",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// dsh's client bundler only exposes the classic React API, so we build
		// every node with React.createElement directly (no jsx-runtime).
		const e = react.createElement;

		/** Same-origin endpoints exposed by the host half. */
		const CONFIG_ENDPOINT = "/browser-use/config";
		const CLEAR_ENDPOINT = "/browser-use/clear";
		const COMMAND_ENDPOINT = "/browser-use/command";
		const STATE_ENDPOINT = "/browser-use/state";
		const STREAM_ENDPOINT = "/browser-use/stream";

		/** POST one command to the host; returns parsed JSON or null. */
		function command(payload) {
			return fetch(COMMAND_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			})
				.then((res) => res.json())
				.catch(() => null);
		}

		/** Commands issued by the embedded panel (allowed even when AI control is off). */
		function panelCommand(payload) {
			return command({ source: "panel", ...payload });
		}

		/* ------------------------------------------------------------------ *
		 * Styles
		 * ------------------------------------------------------------------ */

		const CSS_TAG = "dsh-browser-use/ui.css";
		const css = [
			// --- settings section ---
			".dshbu-root{display:flex;flex-direction:column;gap:28px;max-width:640px;}",
			".dshbu-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".dshbu-row:last-child{border-bottom:none}",
			".dshbu-text{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dshbu-title{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".dshbu-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dshbu-group{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}",
			".dshbu-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-fill-l1);overflow:hidden}",
			".dshbu-card .dshbu-row{padding:14px 16px;margin:0}",
			".dshbu-switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-label-dimmed);border:none;padding:0;cursor:pointer;transition:background .2s;flex-shrink:0}",
			".dshbu-switch[data-on='true']{background:#22c55e}",
			".dshbu-switch:disabled{opacity:.45;cursor:default}",
			".dshbu-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .2s}",
			".dshbu-switch[data-on='true'] .dshbu-knob{left:18px}",
			".dshbu-btn{font-size:12px;line-height:1;padding:8px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0;transition:opacity .15s}",
			".dshbu-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
			".dshbu-btn:disabled{opacity:.45;cursor:default}",
			".dshbu-btn-danger{background:#ef4444;border-color:#ef4444;color:#fff}",
			".dshbu-btn-danger:hover{background:#dc2626;border-color:#dc2626}",
			".dshbu-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:14px 16px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;gap:8px}",
			".dshbu-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex-shrink:0}",
			".dshbu-dot[data-on='true']{background:#22c55e}",
			".dshbu-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);font-size:12px;line-height:18px;padding:8px 16px;border-radius:8px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:9999}",
			".dshbu-status-msg{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:24px 0}",
			".dshbu-status-msg[data-kind='error']{color:var(--dsw-alias-state-error-primary)}",
			".dshbu-retry{font-size:12px;color:var(--dsw-alias-brand-primary);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline}",
			// --- conversation header action button ---
			".dshbu-hbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:background .15s,color .15s}",
			".dshbu-hbtn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}",
			".dshbu-hbtn[data-on='true']{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-fill-l2)}",
			".dshbu-hbtn svg{width:16px;height:16px;display:block}",
			// --- docked browser pane ---
			".dshbu-panel{position:fixed;top:0;right:0;bottom:0;display:flex;flex-direction:column;width:560px;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-12px 0 40px rgba(0,0,0,.18);z-index:900;overflow:hidden}",
			// WorkBuddy-style docking: the app reflows into the remaining space so
			// the pane never covers conversation content.
			"body.dshbu-docked #root{margin-right:var(--dshbu-w,560px)}",
			".dshbu-resize{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2}",
			".dshbu-panel-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);user-select:none;flex-shrink:0}",
			".dshbu-panel-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}",
			".dshbu-panel-title svg{width:14px;height:14px}",
			".dshbu-panel-head .dshbu-spacer{flex:1}",
			".dshbu-pbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex-shrink:0}",
			".dshbu-pbtn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}",
			".dshbu-pbtn:disabled{opacity:.35;cursor:default}",
			".dshbu-pbtn[data-on='true']{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-fill-l2)}",
			".dshbu-pbtn svg{width:14px;height:14px}",
			// --- tab strip ---
			".dshbu-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;flex-shrink:0;scrollbar-width:thin}",
			".dshbu-tab{display:flex;align-items:center;gap:6px;max-width:180px;height:26px;padding:0 6px 0 10px;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex-shrink:0;border:1px solid transparent}",
			".dshbu-tab:hover{background:var(--dsw-alias-fill-l1)}",
			".dshbu-tab[data-active='true']{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
			".dshbu-tab-title{font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}",
			".dshbu-tab-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;border:none;background:transparent;color:inherit;cursor:pointer;padding:0;flex-shrink:0;opacity:.6}",
			".dshbu-tab-x:hover{background:var(--dsw-alias-fill-l1);opacity:1}",
			".dshbu-tab-x svg{width:10px;height:10px}",
			// --- toolbar ---
			".dshbu-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-shrink:0}",
			".dshbu-url{flex:1;min-width:0;height:28px;font-size:12px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);outline:none}",
			".dshbu-url:focus{border-color:var(--dsw-alias-brand-primary)}",
			".dshbu-vp{height:28px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);cursor:pointer;flex-shrink:0}",
			// --- stage ---
			".dshbu-stage{flex:1;min-height:0;display:flex;align-items:stretch;justify-content:center;background:var(--dsw-alias-fill-l1);position:relative;outline:none}",
			".dshbu-stage img{display:block;max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}",
			".dshbu-stage[data-idle='true']{align-items:center;justify-content:center}",
			".dshbu-stage[data-picker='true'] img{cursor:crosshair}",
			".dshbu-idlebox{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;padding:24px}",
			".dshbu-errbox{position:absolute;left:0;right:0;bottom:0;padding:6px 12px;font-size:11px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshbu-shotview{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}",
			".dshbu-shotview-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-shrink:0}",
			".dshbu-shotview-badge{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshbu-shotview-img{flex:1;min-height:0;object-fit:contain;cursor:zoom-out;background:#000}",
			".dshbu-shotthumb{position:absolute;right:10px;bottom:34px;z-index:6;width:220px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.4);overflow:hidden}",
			".dshbu-shotthumb-img{display:block;width:100%;height:auto;max-height:200px;object-fit:contain;object-position:top;cursor:zoom-in;background:#000}",
			".dshbu-panel-foot{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-shrink:0;white-space:nowrap}",
			".dshbu-foot-title{overflow:hidden;text-overflow:ellipsis;max-width:45%}",
			".dshbu-foot-url{flex:1;overflow:hidden;text-overflow:ellipsis}",
			".dshbu-badge{font-size:10px;line-height:16px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);flex-shrink:0}",
			".dshbu-badge[data-live='true']{color:#16a34a}"
		].join("\n");
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-browser-use";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ------------------------------------------------------------------ *
		 * i18n
		 * ------------------------------------------------------------------ */

		const LOCALE_NS = "settings.browseruse";

		function bindT(locale) {
			if (locale && typeof locale.bind === "function") return locale.bind(LOCALE_NS);
			return (key) => key;
		}

		function useLocaleSnapshot(locale) {
			return react.useSyncExternalStore(
				(callback) => locale.subscribe(callback),
				() => locale.getSnapshot(),
				() => locale.getSnapshot()
			);
		}

		/* ------------------------------------------------------------------ *
		 * Panel open state (module-level store shared by header + settings)
		 * ------------------------------------------------------------------ */

		const panelStore = {
			listeners: new Set(),
			open: false,
			shot: null, // AI-screenshot overlay URL; set by the state poller
			getSnapshot() { return panelStore.open; },
			getShotSnapshot() { return panelStore.shot; },
			subscribe(fn) { panelStore.listeners.add(fn); return () => panelStore.listeners.delete(fn); },
			setOpen(v) { panelStore.open = Boolean(v); panelStore.listeners.forEach((fn) => fn()); },
			setShot(url) { panelStore.shot = url; panelStore.listeners.forEach((fn) => fn()); },
			toggle() { panelStore.setOpen(!panelStore.open); }
		};

		function usePanelOpen() {
			return react.useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot, panelStore.getSnapshot);
		}

		function usePanelShot() {
			return react.useSyncExternalStore(panelStore.subscribe, panelStore.getShotSnapshot, panelStore.getShotSnapshot);
		}

		/* ------------------------------------------------------------------ *
		 * Icons
		 * ------------------------------------------------------------------ */

		function GlobeIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3 },
				e("circle", { cx: 8, cy: 8, r: 6.2 }),
				e("ellipse", { cx: 8, cy: 8, rx: 2.8, ry: 6.2 }),
				e("path", { d: "M2 8h12M2.9 4.8h10.2M2.9 11.2h10.2" })
			);
		}
		function ArrowLeftIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				e("path", { d: "M10.5 3 5.5 8l5 5" })
			);
		}
		function ArrowRightIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				e("path", { d: "M5.5 3l5 5-5 5" })
			);
		}
		function ReloadIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				e("path", { d: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" })
			);
		}
		function CloseIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				e("path", { d: "M4 4l8 8M12 4l-8 8" })
			);
		}
		function PlusIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				e("path", { d: "M8 3.5v9M3.5 8h9" })
			);
		}
		function CrosshairIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3 },
				e("circle", { cx: 8, cy: 8, r: 4.5 }),
				e("path", { d: "M8 1v3.2M8 11.8V15M1 8h3.2M11.8 8H15" })
			);
		}
		function BugIcon() {
			return e("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3 },
				e("rect", { x: 5, y: 5.5, width: 6, height: 7, rx: 2.5 }),
				e("path", { d: "M5.5 4.5 4 3M10.5 4.5 12 3M5 8H2.5M13.5 8H11M5.5 11 4 12.5M10.5 11l1.5 1.5" })
			);
		}

		/* ------------------------------------------------------------------ *
		 * Shared switch control (settings rows)
		 * ------------------------------------------------------------------ */

		function SwitchButton(_ref) {
			const on = _ref.on;
			const disabled = _ref.disabled;
			const onClick = _ref.onClick;
			return e("button", {
				className: "dshbu-switch",
				"data-on": String(Boolean(on)),
				type: "button",
				disabled: Boolean(disabled),
				onClick
			}, e("span", { className: "dshbu-knob" }));
		}

		/* ------------------------------------------------------------------ *
		 * Embedded browser pane (docked live view)
		 * ------------------------------------------------------------------ */

		/** Keyboard event -> CDP dispatchKeyEvent params. */
		function keyPayload(ev, up) {
			const key = ev.key;
			const special = {
				Enter: 13, Backspace: 8, Tab: 9, Escape: 27,
				ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
				Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32
			};
			let vk = special[key];
			if (vk === undefined) {
				if (/^Key[A-Z]$/.test(ev.code || "")) vk = ev.code.charCodeAt(3);
				else if (/^Digit[0-9]$/.test(ev.code || "")) vk = ev.code.charCodeAt(5);
				else if (key.length === 1) {
					const up2 = key.toUpperCase();
					if (up2 >= "A" && up2 <= "Z") vk = up2.charCodeAt(0);
					else if (key >= "0" && key <= "9") vk = key.charCodeAt(0);
				}
			}
			const params = {
				key,
				code: ev.code || key,
				keyCode: vk || 0,
				up,
				ctrl: ev.ctrlKey,
				alt: ev.altKey,
				shift: ev.shiftKey,
				meta: ev.metaKey
			};
			// Printable characters travel as text so the page inserts them.
			if (!up && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) params.text = key;
			return params;
		}

		const VIEWPORT_OPTIONS = [
			{ w: 1280, h: 720 },
			{ w: 1024, h: 768 },
			{ w: 768, h: 1024 },
			{ w: 390, h: 844 }
		];

		const PANEL_WIDTH_KEY = "dshbu.panelWidth";

		/** The right-docked live browser pane. */
		function BrowserPanel(_ref2) {
			const locale = _ref2.locale;
			const t = bindT(locale);
			const open = usePanelOpen();

			const panelRef = react.useRef(null);
			const stageRef = react.useRef(null);
			const imgRef = react.useRef(null);
			const dimsRef = react.useRef({ width: 0, height: 0 }); // page viewport px
			const urlFocused = react.useRef(false);
			const aliveRef = react.useRef(false);
			const streamFailRef = react.useRef(0);

			const [running, setRunning] = react.useState(false);
			const [tabs, setTabs] = react.useState([]);
			const [activeId, setActiveId] = react.useState(null);
			const [meta, setMeta] = react.useState({ title: "", url: "" });
			const [imgSrc, setImgSrc] = react.useState(null);
			const [error, setError] = react.useState("");
			const [urlInput, setUrlInput] = react.useState("");
			const [busyCmd, setBusyCmd] = react.useState(false);
			const [vpValue, setVpValue] = react.useState("auto"); // fit window: page fills the pane
			const [picker, setPicker] = react.useState(false);
			const [toast, setToast] = react.useState("");
			const toastTimer = react.useRef(null);
			const autoStartRef = react.useRef(false);

			/** Flash a short confirmation message inside the pane. */
			const showToast = (text) => {
				setToast(text);
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => setToast(""), 2200);
			};

			/** Apply a `view`-shaped payload (poll fallback path). */
			const applyView = (body) => {
				setImgSrc(body.image ? `data:image/jpeg;base64,${body.image}` : null);
				dimsRef.current = { width: body.width || 0, height: body.height || 0 };
				setMeta({ title: body.title || "", url: body.url || "" });
				if (!urlFocused.current) setUrlInput(body.url === "about:blank" ? "" : (body.url || ""));
			};

			/** Poll lightweight pane state: running flag + tab list. Never launches the browser. */
			react.useEffect(() => {
				if (!open) return undefined;
				let alive = true;
				const tick = () => {
					fetch(STATE_ENDPOINT)
						.then((r) => r.json())
						.then((b) => {
							if (!alive || !b || !b.ok) return;
							setRunning(Boolean(b.running));
							setTabs(Array.isArray(b.tabs) ? b.tabs : []);
							setActiveId(b.activeId || null);
							if (b.running === false) {
								setImgSrc(null);
								dimsRef.current = { width: 0, height: 0 };
							}
						})
						.catch(() => { /* host unreachable; keep last state */ });
				};
				tick();
				const timer = setInterval(tick, 2000);
				return () => { alive = false; clearInterval(timer); };
			}, [open]);

			/** Live screencast stream; falls back to 1s polling after repeated failures. */
			const [streamMode, setStreamMode] = react.useState("stream"); // stream | poll
			react.useEffect(() => {
				if (!open || !running) return undefined;
				aliveRef.current = true;
				const ctrl = new AbortController();

				if (streamMode === "poll") {
					const timer = setInterval(() => {
						panelCommand({ action: "view" }).then((body) => {
							if (body && body.ok && body.running) applyView(body);
							else if (body && body.error) setError(String(body.error));
						});
					}, 1000);
					return () => { aliveRef.current = false; clearInterval(timer); ctrl.abort(); };
				}

				let stopped = false;
				const run = async () => {
					while (!stopped && aliveRef.current) {
						try {
							const res = await fetch(STREAM_ENDPOINT, { signal: ctrl.signal, cache: "no-store" });
							if (!res.ok || !res.body) throw new Error("stream unavailable");
							streamFailRef.current = 0;
							const reader = res.body.getReader();
							const decoder = new TextDecoder();
							let buf = "";
							for (;;) {
								const { done, value } = await reader.read();
								if (done) break;
								buf += decoder.decode(value, { stream: true });
								let idx;
								while ((idx = buf.indexOf("\n")) >= 0) {
									const line = buf.slice(0, idx).trim();
									buf = buf.slice(idx + 1);
									if (!line) continue;
									let obj = null;
									try { obj = JSON.parse(line); } catch { continue; }
									if (obj.image) {
										setImgSrc(`data:image/jpeg;base64,${obj.image}`);
										if (obj.w) dimsRef.current = { width: obj.w, height: obj.h || 0 };
										setError("");
									} else if (obj.running === false) {
										setRunning(false);
									} else if (obj.title !== undefined || obj.url !== undefined) {
										setMeta({ title: obj.title || "", url: obj.url || "" });
										if (!urlFocused.current) setUrlInput(obj.url === "about:blank" ? "" : (obj.url || ""));
									}
									if (obj.error) setError(String(obj.error));
								}
							}
						} catch (err) {
							if (stopped || ctrl.signal.aborted) return;
						}
						if (stopped || !aliveRef.current) return;
						streamFailRef.current += 1;
						if (streamFailRef.current >= 3) {
							setStreamMode("poll");
							return;
						}
						await new Promise((r) => setTimeout(r, 1500));
					}
				};
				run();
				return () => { stopped = true; aliveRef.current = false; ctrl.abort(); };
			}, [open, running, streamMode]);

			/** Wheel forwarding needs a non-passive listener to preventDefault. */
			react.useEffect(() => {
				if (!open) return undefined;
				const el = stageRef.current;
				if (!el) return undefined;
				const onWheel = (ev) => {
					if (!running) return;
					ev.preventDefault();
					panelCommand({ action: "input", type: "wheel", x: 10, y: 10, deltaX: ev.deltaX, deltaY: ev.deltaY });
				};
				el.addEventListener("wheel", onWheel, { passive: false });
				return () => el.removeEventListener("wheel", onWheel);
			}, [open, running]);

			// Dedicated-browser experience: opening the pane lands on Bing right
			// away — no separate "start" click. Fires once per pane-open session;
			// the idle box with the manual start button stays as the fallback.
			// (Hooks must run unconditionally — keep this above the early return.)
			react.useEffect(() => {
				if (!open) { autoStartRef.current = false; return undefined; }
				if (autoStartRef.current || running) return undefined;
				autoStartRef.current = true;
				const timer = setTimeout(() => {
					panelCommand({ action: "navigate", url: "https://www.bing.com" });
				}, 300);
				return () => clearTimeout(timer);
			}, [open, running]);

			// Docked layout: while the pane is open, reserve its width so the
			// conversation reflows beside it instead of being covered.
			react.useEffect(() => {
				document.body.classList.toggle("dshbu-docked", open);
				if (open) {
					const w = (panelRef.current && panelRef.current.style.width) || "560px";
					document.documentElement.style.setProperty("--dshbu-w", w);
				}
				return () => { document.body.classList.remove("dshbu-docked"); };
			}, [open]);

			if (!open) return null;

			/** Left-edge drag handle: resize the docked pane. */
			const onResizeDown = (ev) => {
				ev.preventDefault();
				const el = panelRef.current;
				if (!el) return;
				const startX = ev.clientX;
				const startW = el.getBoundingClientRect().width;
				const move = (e2) => {
					const w = Math.round(Math.max(380, Math.min(window.innerWidth - 80, startW + (startX - e2.clientX))));
					el.style.width = `${w}px`;
					document.documentElement.style.setProperty("--dshbu-w", `${w}px`);
				};
				const up = () => {
					if (panelRef.current) {
						try { localStorage.setItem(PANEL_WIDTH_KEY, panelRef.current.style.width); } catch { /* ignore */ }
					}
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};

			/** Run a toolbar command and refresh soon after. */
			const runCmd = (payload) => {
				if (busyCmd) return;
				setBusyCmd(true);
				panelCommand(payload).finally(() => setTimeout(() => setBusyCmd(false), 400));
			};

			const DEFAULT_HOME = "https://www.bing.com";

			const startBrowser = () => runCmd({ action: "navigate", url: DEFAULT_HOME });

					/** Convert a pointer event on the screenshot into page coordinates.
					 * Uses the ACTUAL rendered content box (natural size + object-fit
					 * letterboxing), not the element box — otherwise every click is
					 * offset when the panel aspect differs from the page aspect. */
					const pagePoint = (ev) => {
						const img = imgRef.current;
						if (!img || !running || !img.naturalWidth) return null;
						const r = img.getBoundingClientRect();
						const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
						const contentW = img.naturalWidth * scale;
						const contentH = img.naturalHeight * scale;
						const offX = r.left + (r.width - contentW) / 2;
						const offY = r.top + (r.height - contentH) / 2;
						const x = Math.round((ev.clientX - offX) / scale);
						const y = Math.round((ev.clientY - offY) / scale);
						if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null; // clicked the letterbox
						return { x, y };
					};

			const onImgMouseDown = (ev) => {
				if (!running) return;
				const pt = pagePoint(ev);
				if (!pt) return;
				ev.preventDefault();
				if (picker) {
					// Element picker: capture selector + summary, copy to clipboard.
					panelCommand({ action: "pick", x: pt.x, y: pt.y }).then((res) => {
						if (res && res.ok && res.selector) {
							const summary = JSON.stringify({
								selector: res.selector,
								tag: res.tag,
								text: res.text,
								title: res.title,
								url: res.url
							}, null, 2);
							navigator.clipboard.writeText(summary)
								.then(() => showToast(t("pickCopied")))
								.catch(() => showToast(t("pickCopied")));
						} else {
							showToast((res && res.error) ? res.error : t("pickFailed"));
						}
					});
					return;
				}
				const button = ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left";
				panelCommand({ action: "input", type: "click", x: pt.x, y: pt.y, button });
				if (stageRef.current) stageRef.current.focus();
			};

			const onStageKeyDown = (ev) => {
				if (!running) return;
				const keysToCapture = ["Backspace", "Tab", "Enter", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", " "];
				if (keysToCapture.includes(ev.key)) ev.preventDefault();
				panelCommand({ action: "input", type: "key", ...keyPayload(ev, false) });
				panelCommand({ action: "input", type: "key", ...keyPayload(ev, true) });
			};

			const applyViewport = (value) => {
				setVpValue(value);
				if (value === "auto") {
					runCmd({ action: "viewport", width: 0, height: 0 });
					return;
				}
				const parts = value.split("x");
				runCmd({ action: "viewport", width: Number(parts[0]), height: Number(parts[1]) });
			};

			const openDevtools = () => {
				panelCommand({ action: "devtools_url" }).then((res) => {
					if (res && res.ok && res.url) window.open(res.url, "_blank", "noopener");
					else showToast((res && res.error) || t("devtoolsFailed"));
				});
			};

			/** Restore the remembered pane width on first render. */
			const savedWidth = (() => {
				try { return localStorage.getItem(PANEL_WIDTH_KEY) || ""; } catch { return ""; }
			})();

			return e("div", { className: "dshbu-panel", ref: panelRef, style: savedWidth ? { width: savedWidth } : undefined },
				// Resize handle (left edge)
				e("div", { className: "dshbu-resize", onMouseDown: onResizeDown }),
				// Header
				e("div", { className: "dshbu-panel-head" },
					e("span", { className: "dshbu-panel-title" }, e(GlobeIcon), t("panelTitle")),
					e("span", { className: "dshbu-badge", "data-live": String(running) }, running ? t("panelLive") : t("panelStopped")),
					e("span", { className: "dshbu-spacer" }),
					e("button", { className: "dshbu-pbtn", type: "button", title: t("panelClose"), onClick: () => panelStore.setOpen(false) }, e(CloseIcon))
				),
				// Tab strip
				e("div", { className: "dshbu-tabs" },
					tabs.map((tab) => e("div", {
						key: tab.id,
						className: "dshbu-tab",
						"data-active": String(tab.id === activeId),
						title: tab.url || tab.title || "",
						onClick: () => runCmd({ action: "switch_tab", tabId: tab.id })
					},
						e("span", { className: "dshbu-tab-title" }, tab.title || tab.url || t("tabUntitled")),
						e("button", {
							className: "dshbu-tab-x",
							type: "button",
							title: t("closeTab"),
							onClick: (ev) => { ev.stopPropagation(); runCmd({ action: "close_tab", tabId: tab.id }); }
						}, e(CloseIcon))
					)),
					e("button", { className: "dshbu-pbtn", type: "button", title: t("newTab"), onClick: () => runCmd({ action: "new_tab", url: "https://www.bing.com" }) }, e(PlusIcon))
				),
				// Toolbar
				e("div", { className: "dshbu-toolbar" },
					e("button", { className: "dshbu-pbtn", type: "button", title: t("back"), disabled: !running, onClick: () => runCmd({ action: "back" }) }, e(ArrowLeftIcon)),
					e("button", { className: "dshbu-pbtn", type: "button", title: t("forward"), disabled: !running, onClick: () => runCmd({ action: "forward" }) }, e(ArrowRightIcon)),
					e("button", { className: "dshbu-pbtn", type: "button", title: t("reload"), disabled: !running, onClick: () => runCmd({ action: "reload" }) }, e(ReloadIcon)),
					e("input", {
						className: "dshbu-url",
						type: "text",
						placeholder: t("urlPlaceholder"),
						value: urlInput,
						spellCheck: false,
						onFocus: () => { urlFocused.current = true; },
						onBlur: () => { urlFocused.current = false; },
						onChange: (ev) => setUrlInput(ev.target.value),
						onKeyDown: (ev) => {
							if (ev.key === "Enter") {
								const url = ev.currentTarget.value.trim();
								if (url) runCmd({ action: "navigate", url });
								ev.currentTarget.blur();
							}
						}
					}),
					e("button", { className: "dshbu-pbtn", type: "button", "data-on": String(picker), title: t("picker"), disabled: !running, onClick: () => setPicker(!picker) }, e(CrosshairIcon)),
					e("button", { className: "dshbu-pbtn", type: "button", title: t("devtools"), disabled: !running, onClick: openDevtools }, e(BugIcon)),
					e("select", { className: "dshbu-vp", value: vpValue, title: t("viewportLabel"), onChange: (ev) => applyViewport(ev.target.value) },
						VIEWPORT_OPTIONS.map((o) => e("option", { key: `${o.w}x${o.h}`, value: `${o.w}x${o.h}` }, `${o.w} × ${o.h}`)),
						e("option", { value: "auto" }, t("viewportAuto"))
					)
				),
				// Stage: live screencast + interactions
				e("div", { className: "dshbu-stage", "data-idle": String(!running), "data-picker": String(picker), ref: stageRef, tabIndex: 0, onKeyDown: onStageKeyDown },
					running
						? e("img", {
							className: "dshbu-shot",
							ref: imgRef,
							src: imgSrc || undefined,
							alt: "",
							draggable: false,
							onMouseDown: onImgMouseDown,
							onContextMenu: (ev) => ev.preventDefault()
						})
					: e("div", { className: "dshbu-idlebox" },
						e(GlobeIcon),
						e("span", null, t("panelIdleHint")),
						e("button", { className: "dshbu-btn", type: "button", onClick: startBrowser }, t("panelStart"))
					),
					// AI screenshots intentionally NOT shown in the panel: they are
					// already embedded inline in the conversation via the chat
					// markdown channel — a panel popup would just cover the live view.
					error ? e("div", { className: "dshbu-errbox" }, error) : null
				),
				// Footer meta
				e("div", { className: "dshbu-panel-foot" },
					e("span", { className: "dshbu-foot-title" }, meta.title || ""),
					e("span", { className: "dshbu-foot-url" }, meta.url || "")
				),
				toast ? e("div", { className: "dshbu-toast" }, toast) : null
			);
		}

		/** Globe button in the conversation session header + AI-activity auto-expand. */
		function HeaderBrowserAction(_ref3) {
			const locale = _ref3.locale;
			const t = bindT(locale);
			const open = usePanelOpen();

			// When the AI opens or navigates a page, auto-expand
			// the pane. The first poll only primes the baseline so a stale
			// activity timestamp from a previous session never triggers a popup.
			react.useEffect(() => {
				let alive = true;
				let primed = false;
				let lastActivity = 0;
				const tick = () => {
					fetch(STATE_ENDPOINT)
						.then((r) => r.json())
						.then((b) => {
							if (!alive || !b || !b.ok) return;
							const act = Number(b.activityAt) || 0;
							if (!primed) { primed = true; lastActivity = act; return; }
							if (act > lastActivity) {
								lastActivity = act;
								if (!panelStore.open) panelStore.setOpen(true);
							}
							// Screenshots are NOT surfaced in the panel anymore: the
							// chat-embed markdown channel already shows them inline
							// in the conversation, a panel popup would be noise.
						})
						.catch(() => { /* ignore */ });
				};
				tick();
				const timer = setInterval(tick, 2000);
				return () => { alive = false; clearInterval(timer); };
			}, []);

			// The panel must be a SIBLING of the button: nesting a div full of
			// interactive controls inside <button> would bubble every panel click
			// into the toggle handler.
			return e(react.Fragment, null,
				e("button", {
					className: "dshbu-hbtn",
					type: "button",
					"data-on": String(open),
					title: t("panelTitle"),
					onClick: () => panelStore.toggle()
				}, e(GlobeIcon)),
				e(BrowserPanel, { locale })
			);
		}

		/* ------------------------------------------------------------------ *
		 * Settings section
		 * ------------------------------------------------------------------ */

		/** The whole Browser Control settings page this plugin contributes. */
		function BrowserUseSection(_ref4) {
			const locale = _ref4.locale;

			useLocaleSnapshot(locale);
			const t = bindT(locale);
			const panelOpen = usePanelOpen();

			const [phase, setPhase] = react.useState("loading"); // loading | ready | error
			const [config, setConfig] = react.useState({ enabled: true, ignoreCertErrors: false, headless: false, browserPath: "" });
			const [runtime, setRuntime] = react.useState({ running: false, browser: null, found: true });
			const [busy, setBusy] = react.useState(false);
			const [toast, setToast] = react.useState("");
			const toastTimer = react.useRef(null);

			/** Flash a short confirmation message. */
			const showToast = (text) => {
				setToast(text);
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => setToast(""), 2400);
			};

			const load = react.useCallback(() => {
				let alive = true;
				fetch(CONFIG_ENDPOINT)
					.then((res) => res.json())
					.then((body) => {
						if (!alive) return;
						if (body && body.ok && body.config) {
							setConfig({ ...config, ...body.config });
							if (body.runtime) setRuntime({ running: false, found: true, ...body.runtime });
							setPhase("ready");
						} else {
							setPhase("error");
						}
					})
					.catch(() => { if (alive) setPhase("error"); });
				return () => { alive = false; };
			}, []);

			react.useEffect(load, []);

			/** Persist one field; the server response is the source of truth. */
			const saveField = (patch) => {
				if (busy) return;
				setBusy(true);
				fetch(CONFIG_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch)
				})
					.then((res) => res.json())
					.then((body) => {
						if (body && body.ok && body.config) {
							setConfig({ ...config, ...body.config });
							if (body.restarted) showToast(t("savedRestart"));
						}
					})
					.catch(() => {})
					.finally(() => { setBusy(false); load(); });
			};

			/** Clear cache or all data; "all" asks for a confirmation first. */
			const clearData = (mode) => {
				if (busy) return;
				if (mode === "all" && !window.confirm(t("confirmClearAll"))) return;
				setBusy(true);
				fetch(CLEAR_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode })
				})
					.then((res) => res.json())
					.then((body) => {
						if (body && body.ok) showToast(body.note || t("cleared"));
						else showToast((body && body.error) || t("clearFailed"));
					})
					.catch(() => showToast(t("clearFailed")))
					.finally(() => { setBusy(false); load(); });
			};

			if (phase === "loading") {
				return e("div", { className: "dshbu-root" }, e("div", { className: "dshbu-status-msg" }, t("loading")));
			}
			if (phase === "error") {
				return e("div", { className: "dshbu-root" },
					e("div", { className: "dshbu-status-msg", "data-kind": "error" },
						t("loadError"), " ",
						e("button", { className: "dshbu-retry", type: "button", onClick: () => { setPhase("loading"); load(); } }, t("retry"))
					)
				);
			}

			return e("div", { className: "dshbu-root" },
				// Master switch — off stops the AI prompt injection entirely.
				e("div", { className: "dshbu-card" },
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("masterTitle")),
							e("div", { className: "dshbu-desc" }, t("masterDesc"))
						),
						e(SwitchButton, {
							on: config.enabled !== false,
							disabled: busy,
							onClick: () => saveField({ enabled: config.enabled === false })
						})
					)
				),
				// Embedded panel shortcut.
				e("div", { className: "dshbu-card" },
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("panelRowTitle")),
							e("div", { className: "dshbu-desc" }, t("panelRowDesc"))
						),
						e("button", {
							className: "dshbu-btn",
							type: "button",
							onClick: () => panelStore.toggle()
						}, panelOpen ? t("panelRowClose") : t("panelRowOpen"))
					)
				),
				// Security group.
				e("span", { className: "dshbu-group" }, t("securityGroup")),
				e("div", { className: "dshbu-card" },
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("certTitle")),
							e("div", { className: "dshbu-desc" }, t("certDesc"))
						),
						e(SwitchButton, {
							on: config.ignoreCertErrors === true,
							disabled: busy,
							onClick: () => saveField({ ignoreCertErrors: config.ignoreCertErrors !== true })
						})
					),
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("headlessTitle")),
							e("div", { className: "dshbu-desc" }, t("headlessDesc"))
						),
						e(SwitchButton, {
							on: config.headless === true,
							disabled: busy,
							onClick: () => saveField({ headless: config.headless !== true })
						})
					)
				),
				// Browsing-data group.
				e("span", { className: "dshbu-group" }, t("dataGroup")),
				e("div", { className: "dshbu-card" },
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("cacheTitle")),
							e("div", { className: "dshbu-desc" }, t("cacheDesc"))
						),
						e("button", {
							className: "dshbu-btn",
							type: "button",
							disabled: busy,
							onClick: () => clearData("cache")
						}, t("cacheAction"))
					),
					e("div", { className: "dshbu-row" },
						e("div", { className: "dshbu-text" },
							e("div", { className: "dshbu-title" }, t("allTitle")),
							e("div", { className: "dshbu-desc" }, t("allDesc"))
						),
						e("button", {
							className: "dshbu-btn dshbu-btn-danger",
							type: "button",
							disabled: busy,
							onClick: () => clearData("all")
						}, t("allAction"))
					),
					e("div", { className: "dshbu-status" },
						e("span", { className: "dshbu-dot", "data-on": String(runtime.running === true) }),
						e("span", null, runtime.running
							? (t("running").replace("{browser}", runtime.browser || t("fallbackBrowser")))
							: (runtime.found === false ? t("notFound") : t("notRunning").replace("{browser}", runtime.browser || t("fallbackBrowser"))))
					)
				),
				toast ? e("div", { className: "dshbu-toast" }, toast) : null
			);
		}

		/* ------------------------------------------------------------------ *
		 * Plugin entry
		 * ------------------------------------------------------------------ */

		/** Client services: slots registry plus the dsh locale service. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: settings section + conversation-header panel toggle.
		 * @param ctx - client cordis context.
		 */
		function apply(ctx) {
			const locale = ctx.locale;
			locale && locale.register && locale.register(LOCALE_NS, {
				zh: {
					nav: "浏览器控制",
					masterTitle: "开启内置浏览器控制",
					masterDesc: "启用 Browser Use 插件，让 AI 会话可以通过内置浏览器访问和操作网页。",
					panelRowTitle: "打开浏览器面板",
					panelRowDesc: "在会话界面右侧打开实时浏览器面板；也可点击会话右上角的地球按钮。AI 打开网页时面板会自动展开。",
					panelRowOpen: "打开面板",
					panelRowClose: "关闭面板",
					securityGroup: "安全",
					certTitle: "忽略证书校验",
					certDesc: "开启后内置浏览器将不校验 HTTPS 证书，仅影响内置浏览器。修改后需重启浏览器生效。",
					headlessTitle: "专属浏览器模式（无独立窗口）",
					headlessDesc: "开启后浏览器在后台运行，只在右侧面板中显示实时画面——把面板当作 dsh 专属浏览器；关闭则弹出独立浏览器窗口。",
					dataGroup: "浏览器数据",
					cacheTitle: "清除内置浏览器缓存",
					cacheDesc: "清除 HTTP 缓存、Cache Storage 和 Service Worker，保留 Cookie 和本地站点数据。",
					cacheAction: "清除缓存",
					allTitle: "清除全部浏览器数据",
					allDesc: "移除内置浏览器中的 Cookie、站点数据和缓存，此操作不可撤销。",
					allAction: "清除全部",
					running: "{browser} 正在运行，AI 可以直接使用",
					notRunning: "{browser} 已就绪，AI 首次使用时自动启动",
					notFound: "未找到 Microsoft Edge 或 Google Chrome，请先安装其一",
					fallbackBrowser: "浏览器",
					savedRestart: "已保存，浏览器将在下次使用时按新配置启动",
					cleared: "已清除",
					clearFailed: "清除失败，请重试",
					confirmClearAll: "确定清除内置浏览器的全部数据（Cookie、站点数据、缓存）？此操作不可撤销。",
					loading: "正在加载浏览器控制设置…",
					loadError: "浏览器控制设置加载失败。",
					retry: "重试",
					panelTitle: "内置浏览器",
					panelLive: "实时",
					panelStopped: "未启动",
					panelClose: "关闭面板",
					panelIdleHint: "内置浏览器以游客（Guest）身份运行：不登录任何账号、不保留历史，也不会与你的日常浏览器同步数据。",
					shotBadge: "AI 截图 · 点击图片或 ✕ 返回实时画面",
					shotBack: "返回实时画面",
					shotThumbBadge: "AI 截图",
					shotExpand: "查看大图",
					shotDismiss: "关闭截图",
					panelStart: "启动浏览器",
					newTab: "新建标签页",
					closeTab: "关闭标签页",
					tabUntitled: "新标签页",
					back: "后退",
					forward: "前进",
					reload: "刷新",
					urlPlaceholder: "输入网址并回车",
					picker: "元素点选：点击页面元素，复制选择器与摘要",
					devtools: "打开 DevTools（新窗口）",
					devtoolsFailed: "无法打开 DevTools",
					pickCopied: "已复制元素选择器与摘要",
					pickFailed: "未能选中元素",
					viewportLabel: "视口尺寸",
					viewportAuto: "适应窗口"
				},
				en: {
					nav: "Browser Control",
					masterTitle: "Enable built-in browser control",
					masterDesc: "Enable the Browser Use plugin so AI sessions can browse and interact with web pages.",
					panelRowTitle: "Open browser panel",
					panelRowDesc: "Open the live browser pane on the right of the conversation view; you can also click the globe button in the session header. The pane auto-expands when the AI opens a page.",
					panelRowOpen: "Open panel",
					panelRowClose: "Close panel",
					securityGroup: "Security",
					certTitle: "Ignore certificate errors",
					certDesc: "The built-in browser will skip HTTPS certificate validation. Only affects the built-in browser; the browser restarts with the new flag on next use.",
					headlessTitle: "Dedicated browser mode (no separate window)",
					headlessDesc: "Runs the browser in the background so the live pane is the only face of it — a dedicated dsh browser. Turn off to pop out a regular browser window.",
					dataGroup: "Browsing data",
					cacheTitle: "Clear built-in browser cache",
					cacheDesc: "Clears HTTP cache, Cache Storage and Service Workers; keeps cookies and local site data.",
					cacheAction: "Clear cache",
					allTitle: "Clear all browser data",
					allDesc: "Removes cookies, site data and cache from the built-in browser. This cannot be undone.",
					allAction: "Clear all",
					running: "{browser} is running; the AI can use it now",
					notRunning: "{browser} ready; it starts automatically on first use",
					notFound: "Microsoft Edge or Google Chrome not found — install either one first",
					fallbackBrowser: "Browser",
					savedRestart: "Saved. The browser will relaunch with the new settings on next use",
					cleared: "Cleared",
					clearFailed: "Failed to clear, please retry",
					confirmClearAll: "Clear all built-in browser data (cookies, site data, cache)? This cannot be undone.",
					loading: "Loading browser control settings…",
					loadError: "Failed to load browser control settings.",
					retry: "Retry",
					panelTitle: "Built-in Browser",
					panelLive: "Live",
					panelStopped: "Stopped",
					panelClose: "Close panel",
					panelIdleHint: "The built-in browser runs in Guest mode: no account sign-in, no history kept, and nothing syncs with your daily browser.",
					shotBadge: "AI screenshot · click the image or ✕ to return to the live view",
					shotBack: "Back to live view",
					shotThumbBadge: "AI screenshot",
					shotExpand: "View full size",
					shotDismiss: "Dismiss screenshot",
					panelStart: "Start browser",
					newTab: "New tab",
					closeTab: "Close tab",
					tabUntitled: "New tab",
					back: "Back",
					forward: "Forward",
					reload: "Reload",
					urlPlaceholder: "Type a URL and press Enter",
					picker: "Element picker: click a page element to copy its selector & summary",
					devtools: "Open DevTools (new window)",
					devtoolsFailed: "Could not open DevTools",
					pickCopied: "Element selector & summary copied",
					pickFailed: "Could not pick an element",
					viewportLabel: "Viewport size",
					viewportAuto: "Fit window"
				}
			});

			const t = bindT(locale);

			// Settings: sidebar entry + page, right below personalization (25 -> 26).
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "browser-use",
						order: 26,
						label: () => t("nav")
					},
					(props) => e(BrowserUseSection, Object.assign({}, props, { locale }))
				)
			);

			// Conversation header: globe button toggling the embedded pane.
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "browser-use-panel",
						order: 30,
						locale: LOCALE_NS
					},
					(props) => e(HeaderBrowserAction, Object.assign({}, props, { locale }))
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
