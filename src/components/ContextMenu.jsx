import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// ContextMenu
// ───────────
// Generic right-click popup. Pure presentation — caller positions it
// and supplies the item list. Visual feel matches MirrorPickerModal /
// DiscoverModal (themed via the same CSS variables).
//
// Items shape:
//   { label, icon?, action: () => void, disabled?, danger?, divider?, group? }
//
// Special items:
//   - divider:true   → renders <hr/>; no label needed
//   - group:true     → unclickable small-caps header (for "N selected" etc.)
//
// Behavior:
//   - Esc closes.
//   - Click outside (mousedown/contextmenu anywhere outside the menu) closes.
//   - Clicking a normal item runs its action() then onClose().
//   - Position flips to fit inside the window (right edge / bottom edge).
export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  // Start positioned offscreen-ish until we measure; then commit a
  // viewport-clamped (x, y). Avoids a one-frame flash in the wrong spot
  // when the right side of the screen needs to flip leftward.
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' });

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 6;
    let left = x;
    let top = y;
    if (left + rect.width + PAD > vw) left = Math.max(PAD, vw - rect.width - PAD);
    if (top + rect.height + PAD > vh) top = Math.max(PAD, vh - rect.height - PAD);
    if (left < PAD) left = PAD;
    if (top < PAD) top = PAD;
    setPos({ left, top, visibility: 'visible' });
  }, [x, y, items]);

  // Esc closes. Mousedown outside closes (handles both left and right
  // clicks via the capture phase, so a right-click somewhere else opens
  // a fresh menu instead of stacking).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); } };
    const onDown = (e) => {
      const node = menuRef.current;
      if (node && node.contains(e.target)) return;
      onClose && onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('contextmenu', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('contextmenu', onDown, true);
    };
  }, [onClose]);

  const handleClick = (item) => {
    if (!item || item.disabled || item.divider || item.group) return;
    try { item.action && item.action(); } finally { onClose && onClose(); }
  };

  return (
    <div
      ref={menuRef}
      className="plugr-context-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.visibility }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (!it) return null;
        if (it.divider) return <div key={`d-${i}`} className="plugr-context-menu-divider" role="separator" />;
        if (it.group) {
          return (
            <div key={`g-${i}`} className="plugr-context-menu-group" role="presentation">
              {it.label}
            </div>
          );
        }
        return (
          <button
            key={`i-${i}-${it.label}`}
            type="button"
            role="menuitem"
            disabled={!!it.disabled}
            className={`plugr-context-menu-item ${it.danger ? 'is-danger' : ''} ${it.disabled ? 'is-disabled' : ''}`}
            onClick={() => handleClick(it)}
          >
            {it.icon && <span className="plugr-context-menu-icon" aria-hidden="true">{it.icon}</span>}
            <span className="plugr-context-menu-label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
