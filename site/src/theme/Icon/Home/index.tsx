import React from 'react';
import type {Props} from '@theme/Icon/Home';
import {HouseIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconHome(props: Props): React.ReactNode {
  return <HouseIcon {...props} />;
}
