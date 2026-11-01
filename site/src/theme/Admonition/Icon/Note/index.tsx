import React from 'react';
import type {Props} from '@theme/Admonition/Icon/Note';
import {NoteIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function AdmonitionIconNote(props: Props): React.ReactNode {
  return <NoteIcon {...props} />;
}
