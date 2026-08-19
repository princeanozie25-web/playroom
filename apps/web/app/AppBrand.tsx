import Link from 'next/link';

export function AppBrand({ href = '/' }: { href?: string }) {
  return (
    <Link className="app-brand" href={href} aria-label="Playroom home">
      <span className="app-brand__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Playroom</span>
    </Link>
  );
}
