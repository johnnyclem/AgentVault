import React from 'react';
import clsx from 'clsx';
import {ThemeClassNames} from '@docusaurus/theme-common';
import type {Props} from '@theme/Footer/Layout';

/**
 * Swizzled so the footer sits on the page's two column grid: the link columns
 * on the left, the manifest (the site's signature) on the right, and the
 * copyright left aligned under both. Every row is a fact of the repo: the npm
 * package name (package.json), the MIT license (LICENSE) and the Node.js
 * range the docs ask for (quick start prerequisites, engines in package.json).
 * The version is left out on purpose: package.json is ahead of the npm release.
 */
export default function FooterLayout({style, links, logo, copyright}: Props): React.ReactNode {
  const rows: Array<{label: string; value: string}> = [
    {label: 'Package', value: 'agentvault on npm'},
    {label: 'License', value: 'MIT'},
    {label: 'Node.js', value: '18+'},
  ];

  return (
    <footer
      className={clsx(ThemeClassNames.layout.footer.container, 'footer', {
        'footer--dark': style === 'dark',
      })}>
      <div className="container container-fluid">
        <div className="av-footerGrid">
          <div className="av-footerLinks">{links}</div>
          <dl className="av-manifest av-footerManifest">
            {rows.map((row) => (
              <div className="av-manifestRow" key={row.label}>
                <dt className="av-manifestKey">{row.label}</dt>
                <dd className="av-manifestValue">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {(logo || copyright) && (
          <div className="footer__bottom">
            {logo && <div className="margin-bottom--sm">{logo}</div>}
            {copyright}
          </div>
        )}
      </div>
    </footer>
  );
}
