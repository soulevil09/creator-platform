'use client';

// Section navigation for the admin console. `aria-current="page"` marks the
// active section from the pathname; there is no client-side data here.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

const SECTIONS = [
  { href: '/admin', key: 'overview' },
  { href: '/admin/models', key: 'models' },
  { href: '/admin/users', key: 'users' },
  { href: '/admin/payouts', key: 'payouts' },
  { href: '/admin/reports', key: 'reports' },
] as const;

const styles = {
  nav: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0 0' },
  link: {
    padding: '0.35rem 0.8rem',
    borderRadius: 9999,
    border: '1px solid #334155',
    color: '#cbd5e1',
    textDecoration: 'none',
    fontSize: '0.9rem',
  },
  active: { borderColor: '#38bdf8', color: '#f8fafc', background: 'rgba(14, 165, 233, 0.15)' },
} as const;

export function AdminNav() {
  const t = useTranslations('admin.nav');
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} style={styles.nav}>
      {SECTIONS.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            style={{ ...styles.link, ...(active ? styles.active : {}) }}
          >
            {t(section.key)}
          </Link>
        );
      })}
    </nav>
  );
}
