import React from 'react';
import type {Props} from '@theme/Icon/Close';
import {CloseIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconClose(props: Props): React.ReactNode {
  return <CloseIcon {...props} />;
}
