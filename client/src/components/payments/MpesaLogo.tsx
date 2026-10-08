/** M-Pesa wordmark-style badge (drawn inline; no external images). */
export function MpesaLogo({ small = false }: { small?: boolean }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md bg-white font-black tracking-tight ring-1 ring-slate-200 ${small ? 'h-5 px-1 text-[8px]' : 'h-9 w-14 text-[11px]'}`} aria-label="M-Pesa">
      <span className="text-[#4caf50]">M</span>
      <span className="mx-[1px] inline-block rounded-[2px] bg-[#e53935] px-[2px] text-white">-</span>
      <span className="text-[#4caf50]">PESA</span>
    </span>
  );
}
