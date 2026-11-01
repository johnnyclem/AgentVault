import React from 'react';
import type {Props} from '@theme/Icon/Menu';
import {MenuIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconMenu(props: Props): React.ReactNode {
  return <MenuIcon {...props} />;
}
