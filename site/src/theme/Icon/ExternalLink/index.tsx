import React from 'react';
import {translate} from '@docusaurus/Translate';
import type {Props} from '@theme/Icon/ExternalLink';
import {ArrowUpRightIcon} from '@site/src/components/Icons';

/**
 * Swizzled so external links in the navbar, footer and docs use the same
 * arrow as the home page. It keeps the original's accessible name.
 */
export default function IconExternalLink(props: Props): React.ReactNode {
  return (
    <ArrowUpRightIcon
      className="av-iconExternal"
      aria-hidden={undefined}
      role="img"
      aria-label={translate({
        id: 'theme.IconExternalLink.ariaLabel',
        message: '(opens in new tab)',
        description: 'The ARIA label for the external link icon',
      })}
      {...props}
    />
  );
}
