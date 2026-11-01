import React from 'react';
import type {Props} from '@theme/Icon/WordWrap';
import {WrapTextIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconWordWrap(props: Props): React.ReactNode {
  return <WrapTextIcon {...props} />;
}
