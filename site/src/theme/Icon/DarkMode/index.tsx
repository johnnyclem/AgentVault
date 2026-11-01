import React from 'react';
import type {Props} from '@theme/Icon/DarkMode';
import {MoonIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconDarkMode(props: Props): React.ReactNode {
  return <MoonIcon {...props} />;
}
