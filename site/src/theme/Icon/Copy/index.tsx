import React from 'react';
import type {Props} from '@theme/Icon/Copy';
import {CopyIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconCopy(props: Props): React.ReactNode {
  return <CopyIcon {...props} />;
}
