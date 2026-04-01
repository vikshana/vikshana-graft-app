'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

interface MultiSelectProps {
  /** Display label used in placeholder and count badge, e.g. "Team" */
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}

/**
 * Searchable multi-select dropdown with checkbox list and chip count badge.
 * Fully theme-aware via CSS variables.
 */
export function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* Close on outside click */
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /* Auto-focus search input when dropdown opens */
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggleOption = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter(v => v !== value)
        : [...selected, value],
    );
  };

  const triggerText =
    selected.length === 0
      ? `All ${label}s`
      : selected.length === 1
      ? selected[0]
      : `${selected.length} ${label}s`;

  return (
    <div ref={containerRef} className="relative">
      {/* ── Trigger button ─────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full h-9 flex items-center justify-between gap-2 px-3 rounded-lg border text-sm transition-colors"
        style={{
          background: 'var(--input)',
          borderColor: open ? 'var(--primary)' : 'var(--border)',
          color: selected.length > 0 ? 'var(--foreground)' : 'var(--muted-foreground)',
          outline: open ? '2px solid transparent' : undefined,
          boxShadow: open ? '0 0 0 2px rgba(0,186,212,0.2)' : undefined,
        }}
      >
        <span className="truncate text-left text-[13px]">{triggerText}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {selected.length > 0 && (
            <span
              className="text-[9px] font-semibold px-1.5 py-[2px] rounded leading-none"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-foreground)',
                fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {selected.length}
            </span>
          )}
          <svg
            className={clsx('w-3.5 h-3.5 transition-transform duration-150', open && 'rotate-180')}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}
            style={{ color: 'var(--muted-foreground)' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {/* ── Dropdown panel ─────────────────────────────────────── */}
      {open && (
        <div
          className="absolute top-full left-0 z-50 mt-1 rounded-lg border overflow-hidden"
          style={{
            background: 'var(--card)',
            borderColor: 'var(--border)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,186,212,0.1)',
            minWidth: '200px',
            width: '100%',
          }}
        >
          {/* Search row */}
          <div className="p-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                style={{ color: 'var(--muted-foreground)' }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder={`Search ${label.toLowerCase()}s…`}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && (setOpen(false), setSearch(''))}
                className="w-full h-7 pl-7 pr-2 rounded text-xs outline-none"
                style={{
                  background: 'var(--muted)',
                  color: 'var(--foreground)',
                  fontFamily: 'var(--font-sans, system-ui)',
                }}
              />
            </div>
          </div>

          {/* Options list */}
          <div className="overflow-y-auto" style={{ maxHeight: '220px' }}>
            {filtered.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
                No matches for &ldquo;{search}&rdquo;
              </div>
            ) : (
              filtered.map(option => {
                const checked = selected.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => toggleOption(option)}
                    className="w-full flex items-center gap-2.5 px-3 py-[7px] text-[13px] text-left transition-colors"
                    style={{
                      color: checked ? 'var(--primary)' : 'var(--foreground)',
                      background: checked ? 'rgba(0,186,212,0.07)' : 'transparent',
                    }}
                    onMouseEnter={e => {
                      if (!checked) (e.currentTarget as HTMLButtonElement).style.background = 'var(--muted)';
                    }}
                    onMouseLeave={e => {
                      if (!checked) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                    }}
                  >
                    {/* Checkbox */}
                    <span
                      className="w-[15px] h-[15px] rounded-[3px] border flex items-center justify-center shrink-0 transition-colors"
                      style={{
                        borderColor: checked ? 'var(--primary)' : 'var(--muted-foreground)',
                        background: checked ? 'var(--primary)' : 'transparent',
                      }}
                    >
                      {checked && (
                        <svg className="w-[9px] h-[9px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5} style={{ color: 'var(--primary-foreground)' }}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                    </span>
                    <span className="truncate leading-snug">{option}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer: count + clear */}
          <div
            className="px-3 py-2 flex items-center justify-between"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <span
              className="text-[10px]"
              style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
            >
              {selected.length > 0 ? `${selected.length} / ${options.length} selected` : `${options.length} option${options.length !== 1 ? 's' : ''}`}
            </span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => { onChange([]); setSearch(''); }}
                className="text-[10px] font-semibold tracking-wider transition-opacity hover:opacity-60"
                style={{ color: 'var(--destructive)', fontFamily: 'var(--font-mono, monospace)' }}
              >
                CLEAR
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

