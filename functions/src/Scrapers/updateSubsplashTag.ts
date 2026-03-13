import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import updateSubsplashSermonTopics from '../helpers/updateSubsplashTagsHelper';
import { Sermon } from '../../../types/SermonTypes';
import { ListType } from '../../../types/List';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { authenticateSubsplash } from '../subsplashUtils';
import { subsplashSecrets } from '../subsplashSecrets';

// Import retry IDs
const retryIdsSet = new Set([
    "0281cd95-e6ef-4758-aeec-6765dfe136ea",
    "044f86f8-22dd-4bda-8cdc-7e890665db29",
    "095a3520-ffd9-4f74-b7c4-5e150bc65b7e",
    "09afcd53-43bb-4a28-a713-c80af1d43831",
    "09c83b34-99e3-46bb-b9eb-6cf9b1143615",
    "0a473ed7-6ea5-4f4c-943b-04ab2c0f8b20",
    "0c298106-f02e-4c91-aa5d-38a0c27c57fe",
    "0e467a2c-1b2a-482e-aa7e-fc41dc33dc92",
    "12f960cd-ae51-4fa3-b65b-b88f05ae44a7",
    "1555c700-ca5f-4ef2-a9da-6077f051b522",
    "15576e3d-6765-4f79-bd4c-92c75814dace",
    "1575d41b-9ab5-4c64-8a14-ad9046f44dc7",
    "15f1548e-4c9c-4d93-b3d5-a27ade4ff2af",
    "197e3f12-9aac-4663-97bf-44fc784901e0",
    "1986ae42-8aa1-470a-880e-94a45f55e025",
    "1ab115db-7ca8-4813-8db3-b649625ac4c7",
    "1af3204b-ba81-4b6f-9195-0e6cec5eb139",
    "1dd203d6-df71-4a04-a82a-2c8f9ac429a3",
    "1e9d7e54-1377-4283-97eb-4a0a32c7412a",
    "20883597-0b5e-47ba-99ea-3585a2f95f71",
    "21b87c15-0e42-4e89-85d7-b962c093577e",
    "21cb520f-e04f-4342-8688-eb762e842cea",
    "226fa4b0-efc7-432f-ace8-73f1e45ffe71",
    "24760bfd-9ce1-47ac-85a8-2e065e2f1895",
    "2843e3e7-8e1b-46cc-9951-4060bf2cc8fe",
    "292e69c1-55f7-4f47-91ed-c1f300e2b1d4",
    "292e6a68-710e-4e47-b60b-5a1f30bf1af7",
    "2b2b305d-b512-4556-8619-d3751f855fd1",
    "2b3b9fd3-993f-41a7-9f52-365b7859daba",
    "2b8a5206-a9b8-46ef-9d08-e9f00e00417a",
    "2c8cd8c3-e8d4-4585-bbf1-e6bf55a9f94d",
    "2d0cca20-8e83-4a08-9610-0a803cebc63a",
    "2da15004-5e48-4b1a-916b-959a9968e36a",
    "2f4b4d27-f833-4fd0-9e14-af7b137e8fa0",
    "30b4f669-bc1e-463a-8eed-ec9284f08985",
    "31f04b21-cff4-406e-acf9-d148df1003d4",
    "3211af51-99ac-4af0-b86e-8fbd721214ef",
    "324ca97a-24c9-49b7-a98d-a779ceb1baf3",
    "3289a9dd-b461-476b-9dd4-824704a57126",
    "33b1e1c1-25e2-4267-913b-97093a456edf",
    "35218227-7c61-4f73-a2dc-5622a716c7f6",
    "36c59522-116e-4342-ad75-4da2cf0fea33",
    "3770c894-97fa-4d28-82c3-751b7d310993",
    "38917768-2e1b-4d66-8110-0c2c80b813db",
    "38980a13-0e0a-4702-8eef-fed3d89286d0",
    "38c036ce-3bb2-4555-8a36-7c122b15fe57",
    "39439afd-ac40-4976-98cf-e0e762f6968d",
    "397871f8-d43f-4b30-9dd9-9902deab5db3",
    "3ae91e84-ab17-4a0f-8552-2e416bfaefb0",
    "3ccab091-a52b-4143-9a27-fb1e9ce82156",
    "3dcb1f11-ecaa-4c54-8a92-4d2d2621d000",
    "3df7ca94-ff19-423f-a502-bec4d2505ef3",
    "3ec318d0-f60a-4e1e-b915-be7e6841b5c5",
    "3eee7ee7-e267-4c46-a906-6629ae08cca5",
    "3efff16a-d87c-480d-8120-7042b7c6409b",
    "3f26480b-ba25-4382-a877-d74d191bdd9f",
    "425408ae-4799-4249-8352-edff5a037f09",
    "43b8f8af-9424-4eb9-969f-64a721d65d9b",
    "44ffecfe-83f8-4321-819c-7fc03720fce0",
    "451d3bb2-d647-492c-b9bf-fe3e5c58ae6f",
    "45ee8b10-d549-42a1-9ef3-52a232cd6c43",
    "46862493-4129-49db-8ec3-c7cdc6780ae3",
    "46ae4f43-280b-4f50-9c7b-9f2eeb7de128",
    "46fd709d-e51f-408c-a002-d99e5f53137b",
    "482cac56-d8dd-44a5-9c31-d05d1b761537",
    "4a8a61df-f8e8-43cc-a03a-eaca13962918",
    "4bc4519a-6daf-45a8-876c-764893ad526a",
    "4d299659-67a2-41b8-a293-202bfb02d56e",
    "5032a189-e1fe-4d61-ac05-cc5de70c4cf1",
    "51375f2d-6f3f-40aa-a56a-f444a37a7f66",
    "54fff88b-2ba3-432d-9485-ef7fe46ca232",
    "5598058f-861e-46ec-883e-e2db4733ab74",
    "567adc8f-0ca3-4f9d-9976-58d50de19f85",
    "56d6e87f-48ca-457b-a81e-4431c67d3928",
    "56d93729-b37d-46af-b25c-e1f5fa3adbca",
    "56dba007-82c9-4145-99af-81f8ececc2e4",
    "56f66ad0-ce0a-4dec-8950-57d7e4828117",
    "57ca0d61-e1d4-4fe9-8e2f-31f00dbf60bf",
    "59a5be44-160a-4eb1-822c-241e3de948fb",
    "5aacfa34-7b86-4c22-8412-896c1dd64b34",
    "5ade236c-aee9-4b75-b07c-5696dda31cf2",
    "5b061599-1b2a-4307-acf1-b7b64167665c",
    "5c7712b0-e96d-45c3-b855-5f444c7d7a71",
    "5eb2c2a7-d04b-4a34-b680-c45fb82b533a",
    "5ef1f6fd-a477-433f-b788-0d5309f2479f",
    "5fc95531-165a-4106-9cd3-b667d15509cc",
    "62203e61-d622-4c80-94b5-fe278d8cc56a",
    "6242b4fd-ec10-4e87-851c-d17def651e01",
    "63026dfa-e505-4986-b7e6-02d7b433b125",
    "63100f2a-80ff-43a4-a457-e8150c780c4c",
    "63216062-cc51-4168-9dd9-b4d4ec4cbd0a",
    "63cfe766-d618-4fd1-985d-bbbc94e1b64b",
    "6418aa26-3251-457f-bf33-91e09d809e98",
    "65eb5ef1-4763-471c-8801-571dc92f1f27",
    "6617c430-21f0-422e-9b05-4f38984d7f49",
    "683b9164-f495-4880-bce9-fbbd92aac94f",
    "685f7c80-5d0b-418b-87d1-e7644c11aa04",
    "6a579c2d-8d7b-434d-a892-85da97f6ad8e",
    "6a655c24-f525-497b-a24e-97e557bf5266",
    "6cc811b1-93b4-4cee-a382-54aca20229ff",
    "6d44aea4-3fed-4ffe-a080-e27dc3a851cc",
    "6d9f8f0b-2f09-43ee-8690-e6ea56626d91",
    "6dcf54ed-0586-493e-a99e-2481298d39c5",
    "7022e50e-71da-473b-9824-4d4b557b14e9",
    "7043b42c-eb5c-4739-af0d-5793b5fd8971",
    "709b0947-69a8-4a38-bc3c-a80f7b707a55",
    "717a96f3-6580-4a54-a972-b812d027b93a",
    "7201e2f7-23ee-4ebc-ba58-820fc92cf5f7",
    "72880426-a734-47ad-bf50-3651bf55610b",
    "74f34d00-d538-4544-9738-3346e04881c1",
    "78d25df6-e921-4695-ae94-a2a28159aad8",
    "7a037f9e-e557-455b-aa7d-c02cdd734a9f",
    "7c1594bd-5d66-48ef-a4eb-e9ef9771d62c",
    "81755be3-ea10-465d-a3d1-10cb105ecf72",
    "825036c5-9e10-49c4-af41-d5350a7515dd",
    "8269ce8f-08f0-4565-94a2-1def39798760",
    "82d94519-60c6-4b57-bd5a-31f8149f724f",
    "833db316-6ae8-471b-9a4f-0a547634a327",
    "83ddfc46-d05d-4b13-9bda-2728efb07747",
    "84625d65-5440-4acf-928a-e716849b56a8",
    "84c271bc-fa67-43ce-b772-6703752bedcf",
    "851d88b0-5521-4461-9f2e-8fabd8766862",
    "86e71c0c-bb8c-4188-a192-59e8aa1f2984",
    "87ac281d-9783-4c99-bed4-18ed571c449f",
    "8859fca2-1c36-4222-b0e7-d92f27e5fb5e",
    "892e0bf2-637a-4757-8c7f-b1f52eb0b30f",
    "8dd913cb-f1e6-4df3-a50d-5ba2dd0e3b3e",
    "8e2fcb43-750f-4c47-969c-ce810ee5e8da",
    "8e83df0b-e559-410e-8ed9-ef76e8b20d26",
    "8f9c1147-b4c1-4d19-8dd2-30fd2c8e09b7",
    "8fa1a509-48aa-4f8c-a8a1-d76cadd8defa",
    "8fcc8a4a-0dac-43ab-9166-49433d31b7b7",
    "90a91024-8c12-4e6d-a7a5-d9d00244275e",
    "91241a35-b7f6-4f50-9e4a-c1add9f15260",
    "913e7cb7-eee9-4fdf-9e77-c27d142eb483",
    "91b20a88-e6fb-478d-b6bd-aba099f591c0",
    "92e077c8-711d-4e1f-a69e-d8d5a332f15f",
    "930a6e85-ef4e-4c5d-a71f-647b29daf25d",
    "94665054-e526-48c1-abc2-67383d919025",
    "94e0b051-c10a-4237-ab32-f186b1017203",
    "95520e50-6210-4438-8c2d-750274623d83",
    "96d87d71-4b5f-438f-82ec-b1a5c6796180",
    "978e1462-015f-45bf-a5b7-e5d362754fb4",
    "97959bc6-341b-4521-b4e7-15407cadee26",
    "97acbc79-321b-4376-8947-a4c02dc8cf46",
    "984fd42f-49f2-40b7-a574-d1b95417de54",
    "987b8e0f-693c-49dd-8ed8-da24842ba88b",
    "98e2c713-cd98-4504-9795-5b107971b701",
    "990b7e6a-46a2-4c41-8dcf-93cad6447752",
    "99aeb922-b8f1-4bb5-a3a6-41911b0816b3",
    "9a2019ae-2a0f-4d65-8fe4-fcf3921d465c",
    "9a7f2689-f81f-489f-a7c0-92d83619d55c",
    "9a8c9068-bc09-4c01-9283-9a342ab39ceb",
    "9b23282c-e7d9-48d7-81fd-1fefba7ac9a8",
    "9b819128-45ec-451e-a9bf-7c123b8dfaef",
    "9bf1e65d-6651-428a-954f-a0765638786f",
    "9d4eb133-6b07-47cd-b7c7-5f77e6eff567",
    "9ec606f5-9ffc-4155-9993-350497fa281e",
    "9f7b98d4-c7fa-482f-a64e-38eaac84fa4c",
    "9fa28dd0-eb28-4462-b7e7-34dc697d026d",
    "9ffb9bdf-dc59-439b-9175-043c3aba95b8",
    "9ffe0bfa-e7d4-4d42-b4bf-7549a6ba40e8",
    "a0fbf08b-f136-4a83-b534-f01cd614f3ae",
    "a1e5bd1d-ec2f-4a10-9dbd-386cad8bba2d",
    "a209d0ac-6a5a-4c3b-a68d-e5d7b9c42542",
    "a27dbc00-9577-47e1-8aa3-81dded06fdd5",
    "a3196dac-f08a-40c8-95bc-dc798fdaafee",
    "a44c7a36-b6f5-4694-9be6-3b0187881d3d",
    "a472fd1e-2ec2-46bd-b04a-dafb67289a39",
    "a4851799-84fa-4217-ac34-5c9609e659a6",
    "a4be841c-7415-4b66-8699-b4e32d353ada",
    "a4e3277c-bf24-4c13-a4e1-10c6cb536951",
    "a5af3292-054d-4c64-bad0-b8ae242db945",
    "a6465748-c54b-405d-b0c7-20f3d5aa5cc1",
    "a6eec95b-226d-49d9-91ca-4e9177d3e3e9",
    "a88f3cfa-6799-41dc-867f-b2544d8a8b88",
    "aa187675-e3c9-4ccd-9191-ca7ee52486b8",
    "ab61021d-03f3-4708-8266-692ecf2c9f34",
    "ab7205a6-e59f-42fa-a4a4-d4a714d52663",
    "ab81525c-4278-4c11-8ae4-4876124c55c5",
    "ac1bbf54-1f9b-4605-b9bc-f9366cd7d51a",
    "acccb310-8db1-499e-a944-170390160db0",
    "ae47cefb-70c9-46ab-8506-56626973c27a",
    "ae8cd96c-f21e-4fa8-9320-57db8385431c",
    "af1e3d68-9f48-400e-a360-e0e0ac6ca726",
    "af46ce7d-db92-4425-b5fa-b72754345b7c",
    "b0ee5ff5-3dd9-4c05-b800-6881eadec0bf",
    "b1240498-1678-4051-af76-7c841bd57de5",
    "b12720e4-b2cf-4baa-afa6-669530c874d4",
    "b1e298b3-7cd7-44ec-adce-304060012374",
    "b3e83f2b-bbea-4252-9655-c38539f54ad4",
    "b532d39b-a7f0-4b47-9f4c-babac7e8af1b",
    "b743126f-afe9-4130-8e1d-42434601dd54",
    "b74fe5e6-374f-4a65-b033-bedf6740b682",
    "b799c5d3-4bbe-4625-a01e-779c9167da04",
    "b7e2a5ff-973c-4d26-8524-ac8ac57ac7f3",
    "b850900d-21da-4735-883d-5776f6871f5c",
    "b8705686-a3ee-49fa-8c8a-e91f8fd79fdd",
    "b93e48c3-a568-4000-ab68-d3169d135416",
    "bcf05b6a-5658-400e-886b-73db22f235d9",
    "bd2c7809-85a5-4ad2-af09-6012efc0a671",
    "bd622d03-48d5-46a5-ad03-77f420cda917",
    "be3020f0-66a2-42b6-89c7-8e45484b403d",
    "c07eec98-a26d-46fd-b8e8-b23f186f1afc",
    "c125b3be-6722-427b-bb19-9b12d4fff9cb",
    "c21934e4-8d5f-4b18-8415-2fe2aa2fa53f",
    "c25a3f24-f59f-414d-aa66-230f389ade36",
    "c58b1ea7-6c6e-497d-8885-7b6f82511319",
    "c5cd2ab1-6e2d-482b-963b-e8bb256e379c",
    "c5d1517d-07b9-4f20-8b19-91b0cc9ea3ca",
    "c8302ca3-016b-46f0-9d34-9f4de8bc8a6d",
    "c9849bc9-7626-4dad-812b-b6c97eaf3a89",
    "ca7cf3a2-17ba-4a9b-92aa-337197503669",
    "ce92f082-a0c6-4515-bb5e-b40a72f8fb2c",
    "d3019942-949d-4665-8703-173e95869ec6",
    "d50c337f-9c74-4900-b5d8-6635ae61ad59",
    "d64ca529-71d0-4650-9b51-dd8d275f727e",
    "d70216a2-3736-4835-b282-c5075c623fa6",
    "d7c8eccb-5f63-4f8e-81fb-f1046d2faabb",
    "d80b7820-0c0a-480d-bcac-48ad800f74ed",
    "d874d5ce-96ba-4f94-804a-215a86921132",
    "d8979993-451c-4061-b719-40367e976d88",
    "d8bac2bd-88a3-4c97-a43e-2ea7b38e9e1f",
    "db7c176a-6c47-4deb-ab2b-1141afe478c8",
    "dd488e67-95b8-46b0-8fb1-ea2b4aa0d6fe",
    "e25964a1-051b-43db-aa38-dc4cd3973d44",
    "e4334215-dbd1-4695-a419-8ceea31472f9",
    "e5781614-c8b1-4ee6-842e-24f5e85b43ef",
    "e5b5cb02-063e-4323-b579-2732c3558784",
    "e72b888c-3565-461f-ab6f-d9dd5155dd6e",
    "e87d0248-5da9-4c45-bdf0-aa4eb32bbd1e",
    "e8a8b95d-fe55-4729-9495-f88b903eae67",
    "e8a98838-7055-4677-9a84-ab810926ca6e",
    "e8d82d91-3107-4621-b915-9bcca80a4288",
    "e9f675e2-6a10-442a-bcbe-bcdcc2d4f153",
    "eac7542e-cd2a-4199-ac33-6f36f81ee78d",
    "eb3dbebb-0747-491e-9d98-e4f842e0b6ae",
    "eb61fd95-7849-4059-bc87-1f4216eae16b",
    "ec5aaed8-7d2b-49b9-a5d5-38da5dfe2b02",
    "ecefad49-b71f-4a15-99e9-0749b566b8e1",
    "edabb3fa-8020-4319-b38d-c305a428eda3",
    "efe70fcb-50cb-4b24-a444-7cecf285b380",
    "f10c715b-3b92-44fe-92df-c90e4161fe55",
    "f24b3079-2523-422f-bb40-20fece7122ef",
    "f2d70b8e-d200-4f25-906d-f787b8169485",
    "f39f0a0c-8044-44d7-a7a7-bf05aefab56f",
    "f4d91b9a-4c14-44de-86b5-86e7e2221e2f",
    "f5d0a607-764f-47b5-b9b0-4cdb53f1644c",
    "f72288d2-9f0b-4995-8b5d-a8da42cbbec7",
    "f8269110-53cd-43aa-9481-c5fe5131ecbf",
    "fbc88096-52bc-4390-b8ce-75df08e92426",
    "fbf34778-d272-4019-a145-f152c17465f9",
    "fd89e55a-0155-4c8c-8641-61119879e859"
])

export const updateSubsplashTag = onRequest({
    cors: true,
    timeoutSeconds: 3600,
    secrets: subsplashSecrets
}, async (req, res) => {
    const db = firebaseAdmin.firestore();

    try {
        logger.log('Starting sermon topics update process...');
        logger.log(`📋 Loaded ${retryIdsSet.size} sermon IDs for retry from subsplashIds.json`);

        // Get all sermons
        const sermonsSnapshot = await db.collection('sermons').orderBy('createdAtMillis', 'desc').get();
        logger.log(`Found ${sermonsSnapshot.size} sermons to process`);

        const updatedSermons: Sermon[] = [];
        let processedCount = 0;

        // Process each sermon
        for (const sermonDoc of sermonsSnapshot.docs) {
            const sermon: Sermon = { id: sermonDoc.id, ...sermonDoc.data() } as Sermon;
            const currentTopics = sermon.topics || [];
            const newTopics = [...currentTopics]; // Start with existing topics
            let hasUpdates = false;

            // Check if this sermon is in the retry list
            const isRetrySermon = sermon.subsplashId && retryIdsSet.has(sermon.subsplashId);
            if (isRetrySermon) {
                logger.log(`🔄 RETRYING SERMON: "${sermon.title}" (ID: ${sermon.id}) - Found in retry list`);
                hasUpdates = true; // Force update for retry sermons
            }

            // Get all sermonLists for this sermon
            try {
                const sermonListsSnapshot = await db.collection('sermons')
                    .doc(sermon.id)
                    .collection('sermonLists')
                    .where('type', '==', ListType.TOPIC_LIST)
                    .get();
                // Check each sermonList entry
                for (const sermonListDoc of sermonListsSnapshot.docs) {
                    const sermonListData = sermonListDoc.data();

                    // This sermon is in this topic list, add the list title to topics if not already present
                    if (!newTopics.includes(sermonListData.name)) {
                        newTopics.push(sermonListData.name);
                        hasUpdates = true;
                    }
                }
            } catch (error) {
                logger.error(`Error checking sermonLists for sermon ${sermon.id}:`, error);
            }

            // If topics were updated or this is a retry sermon, prepare for batch update
            if (hasUpdates) {
                // Only store what we need for updates - avoid spreading entire sermon object
                const updatedSermon: Sermon = {
                    ...sermon,
                    topics: newTopics
                };
                updatedSermons.push(updatedSermon);

                if (isRetrySermon) {
                    logger.log(`🔄 RETRY: Sermon "${sermon.title}" (${sermon.id}) added to update batch with topics: [${newTopics.join(', ')}]`);
                } else {
                    logger.log(`Sermon "${sermon.title}" updated with new topics: [${newTopics.join(', ')}]`);
                }
            }

            processedCount++;
            if (processedCount % 100 === 0) {
                logger.log(`Processed ${processedCount}/${sermonsSnapshot.size} sermons`);
            }
        }

        logger.log(`Found ${updatedSermons.length} sermons that need topic updates`);

        if (updatedSermons.length === 0) {
            logger.log('No sermons need updating');
            res.status(200).json({
                success: true,
                message: 'No sermons needed topic updates',
                stats: {
                    totalSermons: sermonsSnapshot.size,
                    sermonsUpdated: 0,
                    subsplashUpdates: 0
                }
            });
            return;
        }

        // Batch update Firestore (max 500 operations per batch)
        const MAX_FIRESTORE_BATCH_SIZE = 500;
        let firestoreBatch = db.batch();
        let firestoreBatchCount = 0;
        let totalFirestoreUpdates = 0;

        for (const updatedSermon of updatedSermons) {
            // Explicitly only update the topics field to avoid touching other fields like createdAtMillis
            firestoreBatch.update(db.collection('sermons').doc(updatedSermon.id), {
                topics: updatedSermon.topics,
            });
            firestoreBatchCount++;

            if (firestoreBatchCount >= MAX_FIRESTORE_BATCH_SIZE) {
                await firestoreBatch.commit();
                logger.log(`Committed Firestore batch of ${firestoreBatchCount} updates`);
                totalFirestoreUpdates += firestoreBatchCount;
                firestoreBatch = db.batch();
                firestoreBatchCount = 0;
            }
        }

        // Commit remaining Firestore updates
        if (firestoreBatchCount > 0) {
            await firestoreBatch.commit();
            logger.log(`Committed final Firestore batch of ${firestoreBatchCount} updates`);
            totalFirestoreUpdates += firestoreBatchCount;
        }

        logger.log(`Completed ${totalFirestoreUpdates} Firestore updates`);

        // Update Subsplash in batches of 50
        const SUBSPLASH_BATCH_SIZE = 50;
        let subsplashUpdates = 0;
        let bearerToken = await authenticateSubsplash();
        for (let i = 0; i < updatedSermons.length; i += SUBSPLASH_BATCH_SIZE) {
            const batch = updatedSermons.slice(i, i + SUBSPLASH_BATCH_SIZE);

            logger.log(`Processing Subsplash batch ${Math.floor(i / SUBSPLASH_BATCH_SIZE) + 1} of ${Math.ceil(updatedSermons.length / SUBSPLASH_BATCH_SIZE)} (${batch.length} sermons)`);

            // Process batch in parallel for better performance
            const subsplashPromises = batch.map(async (sermon) => {
                try {
                    await updateSubsplashSermonTopics(sermon, bearerToken);
                    return true;
                } catch (error) {
                    logger.error(`Failed to update Subsplash for sermon ${sermon.id}:`, error);
                    return false;
                }
            });

            const results = await Promise.allSettled(subsplashPromises);
            const successCount = results.filter(result =>
                result.status === 'fulfilled' && result.value === true
            ).length;

            subsplashUpdates += successCount;
            logger.log(`Subsplash batch completed: ${successCount}/${batch.length} successful updates`);

            // Small delay between batches to avoid overwhelming Subsplash API
            if (i + SUBSPLASH_BATCH_SIZE < updatedSermons.length) {
                logger.log('Re-authenticating Subsplash');
                bearerToken = await authenticateSubsplash();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const result = {
            success: true,
            message: 'Sermon topics update completed successfully',
            stats: {
                totalSermons: sermonsSnapshot.size,
                sermonsUpdated: updatedSermons.length,
                firestoreUpdates: totalFirestoreUpdates,
                subsplashUpdates: subsplashUpdates
            }
        };

        logger.log('Update process completed:', result);
        res.status(200).json(result);

    } catch (error) {
        logger.error('Error during sermon topics update:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Failed to complete sermon topics update'
        });
    }
});
