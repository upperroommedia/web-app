# Shared Domain Types

The Shared Domain Types context defines canonical records and vocabulary shared by the web app, Firebase functions, and process-audio.

## Language

**Sermon**:
The canonical media record for a sermon, including content metadata, audio processing status, publishing status, and ownership.
_Avoid_: Media item, track

**Sermon Status**:
The aggregate status for a sermon across audio processing, Subsplash publishing, and SoundCloud publishing.
_Avoid_: State, lifecycle

**Upload Status**:
The status of a publishable record or membership for a destination: not uploaded, uploaded, or errored.
_Avoid_: Publish status, sync status

**Publish Activity**:
The visible in-progress publishing operation for a sermon across lists, series, or SoundCloud.
_Avoid_: Progress, busy state

**List**:
A canonical collection record with type, images, capacity, overflow behavior, and optional Subsplash identity.
_Avoid_: Playlist, collection

**List Type**:
The purpose of a list, such as series, speaker list, topic list, category list, or latest.
_Avoid_: Category, kind

**List Tag**:
A structured classification used for generated or special lists such as Bible chapter, Sunday homily month, or Holy Week.
_Avoid_: Label, topic

**Overflow Behavior**:
The rule for handling list capacity: error, create a new list, or remove the oldest content.
_Avoid_: Capacity policy

**Sermon List**:
A list membership attached to a sermon with membership-level upload status.
_Avoid_: List row, list item

**Series**:
An ordered sermon grouping that is distinct from a list and can be published to Subsplash.
_Avoid_: List, playlist

**Series Item**:
A sermon inside a series with order and Subsplash membership state.
_Avoid_: Episode, item

**Speaker**:
A person associated with sermons, speaker lists, and optional Subsplash tag/list identity.
_Avoid_: Presenter, preacher

**Image**:
A reusable media image with size, aspect type, storage link, and optional Subsplash identity.
_Avoid_: Photo, artwork

**User Role**:
The permission role assigned to a user: admin, uploader, publisher, or user.
_Avoid_: Permission, access level

**Directory User**:
The admin-facing representation of a Firebase Auth user.
_Avoid_: Auth user, account
