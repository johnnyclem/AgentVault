import React from 'react';
import type {Props} from '@theme/Admonition/Icon/Danger';
import {OctagonAlertIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function AdmonitionIconDanger(props: Props): React.ReactNode {
  return <OctagonAlertIcon {...props} />;
}
