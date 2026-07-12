# Web App

The Web App context is the administrator-facing experience for managing sermons, speakers, lists, series, upload state, search, and publishing destinations.

## Language

**Sermon**:
A media item prepared by Upper Room Media with title, description, speakers, topics, images, audio status, and publishing status.
_Avoid_: Track, episode, message

**Speaker**:
A person associated with sermons and, when published, with speaker-specific tagging or list metadata.
_Avoid_: Presenter, preacher, author

**List**:
A curated collection that can contain sermons or other remote content and may be synchronized to Subsplash.
_Avoid_: Playlist, collection

**Sermon List**:
The membership of one sermon in one list, including whether that membership has been published to Subsplash.
_Avoid_: List item, association

**Series**:
An ordered group of sermons where each sermon belongs to at most one series at a time.
_Avoid_: List, playlist

**Series Item**:
A sermon membership inside a series, including local order and whether the membership is published to Subsplash.
_Avoid_: Episode, row

**Publishing Destination**:
An external place a sermon can be sent to, currently Subsplash, SoundCloud, or a Subsplash series/list membership.
_Avoid_: Channel, provider

**Publish Activity**:
The current publish or unpublish operation visible to admins for lists, series, or SoundCloud.
_Avoid_: Loading state, progress

**Upload Status**:
Whether a sermon or membership is not uploaded, uploaded, or errored for a publishing destination.
_Avoid_: Sync status, publish flag

**Search Catalog**:
The searchable index of sermons, speakers, lists, series, and images used by admin workflows.
_Avoid_: Algolia index, search client

**Remote Media Item**:
A Subsplash media item corresponding to a local sermon.
_Avoid_: Subsplash sermon, remote sermon

**Local Projection**:
A Firestore copy of sermon data embedded under another record, such as a list's visible sermon rows.
_Avoid_: Cache, duplicate
