import React from 'react';
import type {Props} from '@theme/Admonition/Icon/Warning';
import {TriangleAlertIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function AdmonitionIconWarning(props: Props): React.ReactNode {
  return <TriangleAlertIcon {...props} />;
}
