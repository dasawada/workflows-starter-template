import { LIMITS } from "../../builder/limits";
import { buttonsTextMax, carouselTextMax } from "../../builder/toLine";
import type { ColumnDraft, MessageDraft } from "../../builder/types";
import { postbackAction } from "../../builder/types";
import { ActionList } from "./ActionEditor";
import { Group, SmallButton, TextField } from "./fields";

interface Props {
	message: MessageDraft;
	onChange: (m: MessageDraft) => void;
}

export function MessageForm({ message: m, onChange }: Props) {
	switch (m.kind) {
		case "text":
			return (
				<TextField
					label="文字內容"
					value={m.text}
					onChange={(v) => onChange({ ...m, text: v })}
					max={LIMITS.text}
					multiline
					rows={8}
					required
				/>
			);

		case "confirm":
			return (
				<div className="space-y-3">
					<TextField
						label="問句"
						value={m.text}
						onChange={(v) => onChange({ ...m, text: v })}
						max={LIMITS.confirm.text}
						multiline
						rows={3}
						required
					/>
					<TextField
						label="通知列文字"
						value={m.altText}
						onChange={(v) => onChange({ ...m, altText: v })}
						max={LIMITS.altText}
						hint="手機通知與聊天列表顯示的文字，留空用問句"
					/>
					<ActionList actions={m.actions} min={2} max={2} onChange={(actions) => onChange({ ...m, actions })} />
				</div>
			);

		case "buttons": {
			const hasTitleOrImage = Boolean(m.title.trim() || m.imageUrl.trim());
			return (
				<div className="space-y-3">
					<TextField label="標題" value={m.title} onChange={(v) => onChange({ ...m, title: v })} max={LIMITS.buttons.title} />
					<TextField
						label="內文"
						value={m.text}
						onChange={(v) => onChange({ ...m, text: v })}
						max={buttonsTextMax(hasTitleOrImage)}
						multiline
						rows={3}
						required
						hint={hasTitleOrImage ? "有標題或圖片時內文只能 60 字" : "沒有標題與圖片時可到 160 字"}
					/>
					<TextField label="圖片網址（選填）" value={m.imageUrl} onChange={(v) => onChange({ ...m, imageUrl: v })} max={LIMITS.imageUrl} type="url" placeholder="https://" />
					<TextField label="通知列文字" value={m.altText} onChange={(v) => onChange({ ...m, altText: v })} max={LIMITS.altText} hint="留空用標題或內文" />
					<ActionList actions={m.actions} min={LIMITS.buttons.actionsMin} max={LIMITS.buttons.actionsMax} onChange={(actions) => onChange({ ...m, actions })} />
				</div>
			);
		}

		case "carousel": {
			const setColumn = (i: number, c: ColumnDraft) => onChange({ ...m, columns: m.columns.map((x, j) => (j === i ? c : x)) });
			const addColumn = () => {
				const template = m.columns[m.columns.length - 1];
				const actions = template
					? template.actions.map((a) => ({ ...a }))
					: [postbackAction("承接", "accept")];
				onChange({ ...m, columns: [...m.columns, { title: "", text: "", imageUrl: "", actions }] });
			};
			const removeColumn = (i: number) => onChange({ ...m, columns: m.columns.filter((_, j) => j !== i) });
			return (
				<div className="space-y-3">
					<TextField label="通知列文字" value={m.altText} onChange={(v) => onChange({ ...m, altText: v })} max={LIMITS.altText} hint="留空用第一張卡的標題" />
					<p className="text-[11px] text-neutral-500">每張卡的按鈕數量要一樣；圖片與標題要全部有或全部沒有。</p>
					{m.columns.map((c, i) => {
						const hasTitleOrImage = Boolean(c.title.trim() || c.imageUrl.trim());
						return (
							<Group
								key={i}
								title={`卡 ${i + 1}`}
								right={m.columns.length > 1 ? <SmallButton onClick={() => removeColumn(i)} danger>移除</SmallButton> : null}
							>
								<TextField label="標題" value={c.title} onChange={(v) => setColumn(i, { ...c, title: v })} max={LIMITS.carousel.title} />
								<TextField
									label="內文"
									value={c.text}
									onChange={(v) => setColumn(i, { ...c, text: v })}
									max={carouselTextMax(hasTitleOrImage)}
									multiline
									rows={2}
									required
								/>
								<TextField label="圖片網址（選填）" value={c.imageUrl} onChange={(v) => setColumn(i, { ...c, imageUrl: v })} max={LIMITS.imageUrl} type="url" placeholder="https://" />
								<ActionList actions={c.actions} min={LIMITS.carousel.actionsMin} max={LIMITS.carousel.actionsMax} onChange={(actions) => setColumn(i, { ...c, actions })} />
							</Group>
						);
					})}
					<SmallButton onClick={addColumn} disabled={m.columns.length >= LIMITS.carousel.columnsMax}>
						＋ 新增一張卡（{m.columns.length}/{LIMITS.carousel.columnsMax}）
					</SmallButton>
				</div>
			);
		}

		case "card": {
			const setRow = (i: number, key: "label" | "value", v: string) =>
				onChange({ ...m, rows: m.rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)) });
			return (
				<div className="space-y-3">
					<Group title="色帶標題（選填）">
						<div className="grid grid-cols-[1fr_auto] gap-2 items-end">
							<TextField label="標題" value={m.headerTitle} onChange={(v) => onChange({ ...m, headerTitle: v })} max={LIMITS.card.headerTitle} />
							<label className="block">
								<span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">顏色</span>
								<input type="color" value={m.headerColor} onChange={(e) => onChange({ ...m, headerColor: e.target.value })} className="h-9 w-12 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent" />
							</label>
						</div>
						<TextField label="副標" value={m.headerSubtitle} onChange={(v) => onChange({ ...m, headerSubtitle: v })} max={LIMITS.card.headerSubtitle} />
					</Group>
					<TextField label="主標題" value={m.title} onChange={(v) => onChange({ ...m, title: v })} max={LIMITS.card.title} placeholder="【王小明】「國中數學」" />
					<TextField label="副標題" value={m.subtitle} onChange={(v) => onChange({ ...m, subtitle: v })} max={LIMITS.card.subtitle} />
					<Group
						title={`欄位（${m.rows.length}/${LIMITS.card.rowsMax}）`}
						right={
							<SmallButton onClick={() => onChange({ ...m, rows: [...m.rows, { label: "", value: "" }] })} disabled={m.rows.length >= LIMITS.card.rowsMax}>
								＋ 新增
							</SmallButton>
						}
					>
						{m.rows.map((r, i) => (
							<div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
								<TextField label="名稱" value={r.label} onChange={(v) => setRow(i, "label", v)} max={LIMITS.card.rowLabel} placeholder="首課日" />
								<TextField label="內容" value={r.value} onChange={(v) => setRow(i, "value", v)} max={LIMITS.card.rowValue} />
								<SmallButton onClick={() => onChange({ ...m, rows: m.rows.filter((_, j) => j !== i) })} danger disabled={m.rows.length <= 1}>
									×
								</SmallButton>
							</div>
						))}
					</Group>
					<TextField label="備註長文" value={m.note} onChange={(v) => onChange({ ...m, note: v })} max={LIMITS.card.note} multiline rows={4} />
					<TextField label="通知列文字" value={m.altText} onChange={(v) => onChange({ ...m, altText: v })} max={LIMITS.altText} hint="留空用色帶標題或主標題" />
					<ActionList actions={m.buttons} min={0} max={LIMITS.card.buttonsMax} labelMax={LIMITS.flexButtonLabel} onChange={(buttons) => onChange({ ...m, buttons })} />
				</div>
			);
		}
	}
}
