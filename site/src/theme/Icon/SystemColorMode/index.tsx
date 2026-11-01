import React from 'react';
import type {Props} from '@theme/Icon/SystemColorMode';
import {MonitorIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconSystemColorMode(props: Props): React.ReactNode {
  return <MonitorIcon {...props} />;
}
