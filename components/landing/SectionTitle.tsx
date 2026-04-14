interface SectionTitleProps {
  kicker: string;
  title: string;
  description: string;
}

export function SectionTitle({ kicker, title, description }: SectionTitleProps) {
  return (
    <div className="mx-auto mb-10 max-w-3xl text-center">
      <p className="tracking-[0.18em] text-xs font-semibold uppercase text-teal-700/80">{kicker}</p>
      <h2 className="mt-3 font-display text-3xl font-semibold leading-tight text-slate-900 md:text-4xl">
        {title}
      </h2>
      <p className="mt-3 text-sm text-slate-600 md:text-base">{description}</p>
    </div>
  );
}
