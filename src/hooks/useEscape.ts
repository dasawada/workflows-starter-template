import { useEffect } from "react";

/** 任何暫時性的浮層（對話框、下拉清單）都必須能用 Escape 關閉 */
export function useEscape(onClose: () => void, enabled = true) {
	useEffect(() => {
		if (!enabled) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, enabled]);
}
