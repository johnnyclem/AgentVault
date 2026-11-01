import React from 'react';
import type {Props} from '@theme/Admonition/Icon/Info';
import {InfoIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function AdmonitionIconInfo(props: Props): React.ReactNode {
  return <InfoIcon {...props} />;
}
