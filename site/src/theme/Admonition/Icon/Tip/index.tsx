import React from 'react';
import type {Props} from '@theme/Admonition/Icon/Tip';
import {LightbulbIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function AdmonitionIconTip(props: Props): React.ReactNode {
  return <LightbulbIcon {...props} />;
}
