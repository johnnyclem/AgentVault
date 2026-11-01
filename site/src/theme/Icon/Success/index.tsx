import React from 'react';
import type {Props} from '@theme/Icon/Success';
import {CheckIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconSuccess(props: Props): React.ReactNode {
  return <CheckIcon {...props} />;
}
