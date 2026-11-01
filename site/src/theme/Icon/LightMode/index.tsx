import React from 'react';
import type {Props} from '@theme/Icon/LightMode';
import {SunIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconLightMode(props: Props): React.ReactNode {
  return <SunIcon {...props} />;
}
