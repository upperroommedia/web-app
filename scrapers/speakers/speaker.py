import json

speakers = ['Paul Mansour', 'Wagdy Nada', 'Fr Mina Essak', 'Fr Bishoy El-Antony', 'Natalie Malek', 'Michael Ibrahim', 'Fr Peter Saad', 'Tim Karras', 'Fr Elijah Estafanous', 'Mina Merhem', 'Donna Rizk', 'Francella Brown', 'Fr Elijah Iskander', 'Margaret Sowmi', 'Amani Bishay', 'Stephen Meawad', 'Fr Shenouti Gobran', 'HG Bishop Daniel', 'Mina Boctor', 'Fr Mikhail Mikhail', 'Crestina Jacoup', 'Monica Ibrahim', 'Fr Mina Diskoros', 'Christine Beshara', 'Fr Elisha Soliman', 'Joy Tanios', 'Fr Samuel Hanna', 'Fr Thomas Dos', 'Anthony Zaccariotto', 'Fr Kyrillos Mourad', 'Fr Karas Awad', 'Kirolos Roman', 'Tim Wany', 'Ustina Boulos', 'Dina Malak', 'Hany Hanna', 'HG Bishop Moussa', 'Amir Hanna', 'Mirette Ibrahim', 'Maria Mousa', 'Michael Mina', 'Rola Zaklama', 'Gabby Maurice', 'Daniel Mawad', 'Meena Awad', 'Lydia Moussa', 'Candace Lukasik', 'Lysa Anis', 'Andre Mina', 'Sarah Ecladios', 'Sammy Messih', 'Adel Magdy', 'Boy & King', 'Michael Iskander', 'Christina Labib', 'Mirrae Youssef', 'Medhat Boulos', 'Michael Lewendi', 'Esther Rizk', 'Daniel McInnes', 'Fr Chad Hatfield', 'Heba Estafanous', 'Veronica Malek', 'Samuel Hermena', 'Mina Shenouda', 'Fr Peter Farrington', 'Sherry Fam', 'Metropolitan Basilios Kodsele', 'George Tadros', 'Mary', 'Fr Paul Girguis', 'Fr Bishoy Andrawes', 'Samuel Said', 'Chris Aziz', 'Mark Gabriel', 'Sami Messih', 'HG Bishop Zosima', 'Awny Boulos', 'Mariam Abdelmessih', 'Fr Mina Girgis', 'Atef Fahmy', 'Hany Mikhail', 'Bassem Iskander', 'Fr Daniel Ebrahim', 'Samuel Ibrahim', 'HG Bishop Youannes', 'Moreed William', 'Mary Fanous', 'Dina Bestawros', 'Mina Ghali', 'Daniel Ghobrial', 'Fr Abraham Wassef', 'Ramy Bishai', 'Philip Anthony', 'Fr Younan William', 'Fr Salib Salib', 'Fr Mark Attalla', 'Mark Kilada', 'Remi Abdelsayed', 'Chorus Of St Jacob Serugh Of Vancouver', 'Fr Timothy', 'Fr Arsanious Barsoum', 'Fady', 'Evan Kards', 'Fr James', 'Fr David Azer', 'Fr Pishoy Salama', 'Timothy Tanyous', 'Sherry Mikhail', 'Sandy Jouravlev', 'Fady Atta', 'Youssef Riad', 'Myrna Ishak', 'Mariam Awad', 'George Georgy', 'Anthony Bebawi', 'Anna Abdelmalek', 'Fr David Elias', 'Fiby Henein', 'Deacon Emmanuel Gergis', 'Mirette Fenhas', 'Sam Hermena', 'Daniel Ishak', 'Karim Azer', 'Nabil Baky', 'Jacob Hennien', 'Fr Joshua Tadros', 'Chris Soliman', 'Fr Michael Maximous', 'Terence Pragasam', 'Adelina Gendi', 'Catherine Gerges', 'Mirabel Mikhail', 'Servant of St Mark', 'Amani Bishai', 'Fr Rafael Iskander', 'Fr John St Shenouda', 'HG Bishop Mettaous', 'Nancy Guindi', 'HG Bishop Asheia', 'Samy Messih', 'Fr Daniel Nashed', 'Fr Tony Bartel', 'Youssef Asaad', 'Iris Habib El Masri', 'Merna Gabriel', 'John Mikhail', 'Bassem Morris', 'Kiro Saleeb', 'Johnny Zakarian', 'Olivia Morcos', 'Fr Joseph Ghattas', 'Marianne Sidhom', 'Fady Gad', 'Sister Mary', 'Daniel Khalil', 'Sam Kaldas', 'Johnny Sharkawi', 'Ramez Zaklama', 'Lilyan Andrews', 'Fr Michael Fanous', 'Rami Christophi', 'Martina Ghaly', 'Samuel Beshara', 'Maggie Sowmi', 'Fr Paul Balamon', 'Zeta Petersen', 'Ragy Ibrahim', 'Fr Moses Ayad', 'Abraam Philips', 'Liz Attia', 'Marianne Wilson', 'Fr Kyrillos Farag', 'Albert Os', 'Mark Saad', 'Michael Shehata', 'Mark Melek', 'Mina Tadros', 'Ireni Attia', 'Andrew Bosse', 'Fr Mark Atalla', "St Mark's Melodies", 'Emad Rafla', 'Olivia Morcos, Andro Botros, Mathew Assad, Josh Karras & Chrissy Maurice', 'Edwar Sayegh', 'HG Bishop Basil', 'Joseph Bibawy', 'Fr Michael Salib', 'Norman Mikhail', 'Andrew Boutros', 'Colin Moses Tomes', 'Hany Nematalla', 'Fr Barnabas Melek', 'Kirollos Saleeb', 'Fr Makarios Lyambo', 'Jess Awad', 'Fr Suriel Hanna', 'Garry Warren', 'Cherine Spirou', 'Fr Shenouda', 'Fr Moses Samaan', 'Andro Bottros', 'Sarah Ishak', 'Andrew Malak', 'HG Bishop Youssef', 'Fr Mikhail E. Mikhail', 'Fr Antonios Kaldas', 'Kat Abdel Malek', 'Dr M. Ateia & Fr S.Mathai', 'Gigi Michail', 'Anthony Mansour', 'HG Bishop Athanasius', 'Fr Timothy F', 'Tamar Sidrak', 'Jenny Mikhail', 'Gabriella Maurice', 'Mark Tadrous', 'Jonathan Hakim', 'Fahim Sadek', 'Dina Ibrahim', 'David Makarious', 'David Tadros', 'Fr Moussa Beshara', 'Professor Ashraf A Sadek', 'Louisa Hope', 'Shaheer Gobran', 'Antony Mansour', 'Andrew Selim', 'Bassem Wilson', 'Fr Polycarpus Shoukry', 'Hannan Hanna', 'Prof. Michael Archer', 'Mark Ishak', 'Georgia Gerges', 'Fr Samuel Fanous', 'Mark Sidhom', 'Fr Gabriel Wissa', 'Joe Everett', 'Fred Khoury', 'Fr Morris Morris', 'Fr Mina Dimitri', 'Fr Antony Paul', 'Evellen Tawdros', 'Marc Bastawrous', 'Paul Leslie', 'Avram Ibrahim', 'Mary William', 'Fr David Hanna', 'Ann Greace', 'Fr Pavlos Hanna', 'Fr Anthony Hanna', 'Kirollos Nassief', 'Fr Daniel Abba Moses', 'Hieu Lee', "St Mark's drama group", 'Andrew Messih', 'Aletheia', 'Mina Shehata', 'Sarah Selim Milad', 'Omar Maayah', 'David Betar', 'Magdy Rizk', 'Marianne Botros', 'Peter Ebeid', 'Rasem Guirgis', 'Fr Antonious Tanious', 'Katrina Mikhail', 'Marina Isaac', 'Geovanny Gandy', 'Fr Paul Girgis', 'Fr Anthony Messeh', 'Fr Gabriel Yassa', 'Sam Georgy', 'Steve Messeh', 'Peter Fahmy', 'Tadros Hanna', 'Pola Fanous', 'David Ibrahim', 'Fr Simon Dawood', 'Peter Karras', 'Marianne Botros & Liz Shehata', 'Adelina Ghendi', 'Marina George', 'Fr Seraphim Sidaros', 'Maria Badawi', 'HH Pope Shenouda III', 'Fr Athanasious Ibrahim', 'Dahlia Bashta', 'Mina Iskander', 'Romany, Maryam, Al, Madonna & Maria', 'Tim Tanios',
            'Fr Paula Balamon', 'Andrew Beshara', 'Paul Ghaly', 'John Awad', 'Kirollos Salib', 'Zeta Petersen, Rosemary Azmy, Emma Botros, Steph William', 'Kirollos Assad', 'Chris Saad', 'Bishoy Marcus', 'Andrew Roman', 'Fr Gregory Bishay', 'Chris Estafanous', 'Fr David', 'Fr Anthony St Shenouda', 'Kirollos Roman', 'Paul Hanna', 'Archdeacon Mark Soliman', 'Mimi Azer', 'Fr Michael Soriel', 'Therese Karas', 'Randa Wassef', 'HH Pope Tawadros II', 'Peter Francis', 'Fr Benjamin', 'Danny Abdallah', 'Fr Markos Tadros', 'Sam Hanna', 'Yolanda Rozario', 'Robert Ghannami', 'David Ghebranious', 'Fr Andrew Francis', 'Shenouda Girgis', 'Bish Malik', 'Stephen Sutiono', 'Emad Tadros', 'Josh Ibrahim', 'Martina Bastawrous', 'Fr Mark Basily', 'Fr Lazarus El-Antony', 'Aidan Mclachlan', 'Katie Betar', 'Fr James Gendi', 'John Mazioun', 'Fr Paul Baky', 'Fr Bassilious Gad', 'Fr Yacoub Magdy', 'Maryan Farag', 'Christine Selwains', 'Mark Ghali', 'Maria Demian', 'Yostina Atta', 'David Beshara', 'Mira Ghaly', 'Stephanie Younan', 'HE Metropolitan Basilios', 'Fr Abraham', 'Luke Girgis', 'Fr Reweis', 'Maria Guirguis', 'Janet Law', 'Fr David Abdelsayed', 'Mira Tanios', 'Fr John Ghandour', 'Sarah Bibawy', 'Andrew Nessim', 'Steph Khalil', 'Fr Daniel Habib', 'Fr Peter Dimyan', 'Michael Guirguis', 'Nevine Habib', 'Christina Maurice', 'Andrea Frances', 'Fr Daniel Hanna', 'Veronica Labib', 'Dcn Severus Mikhail', 'Mark Azer', 'Sub-Dcn Timothy Grace', 'Fr Kyrillos Ibrahim', 'Simone Karas', 'Fr Anthony Andrew', 'Fr Thomas Hanna', 'Fr Karas Faragalla', 'Abraham Fanous', 'Nardine Luke', 'Matthew Shehata', 'Fr Timothy Fam', 'Micheal Mina', 'David Aboud', 'Tim Tee', 'Samuel Kaldas', 'Fr Nathanael Guirguis', 'Fr David Milad', 'Mandy Boctor', 'Kris Diskoros', 'Fr Cyril Elnazir', 'Pierre Hanna', 'Fr Tadros Yacoub Malaty', 'Engy Michael', 'Ragaei Shenouda', 'Kirollos Nan', "St Mark's Church", 'Fr Abraham and Dalia Fam', 'Basem Moris', 'Fr K', 'George Gabriel', 'HG Bishop Boulos', 'David Nada', 'Fr David ElMasri', 'Maggie Meleka', 'Dcn Magdy Kilada', 'Fr Benjamin Abouelkheir', 'Maryanne Messeh', 'Jasmine Karras', 'Jo Tsangarides', 'Deena Guirguis', 'St. Paul Coptic Orthodox Mission Church', 'Fr Maurice Ibrahim', 'Mina Hanna', 'Fr Mark Aziz', 'Ehab Wahib', 'Mina Nassief', 'Sarah Anis', 'Fr Bishoy Fakhry Salib', 'Michael Raghib', 'Fr Tawadros Abd-Mariam', 'Rosemary Azmy', 'Jack Ghali', 'Mina Aziz', 'Rebecca Kozman', 'George Farag', 'Michal Wingert', 'Fr Athanasius Iskander', 'Sherry Girguis', 'James Tanios', 'Fr Cyril Abdelmalik', 'Michael Henain', 'David Fanous', 'Peter Mansour', 'Bella Ghaly', 'Gary Raymond', 'Michael Malaty', 'Fr Boulis George', 'Fr David Shehata', 'Andrew Makram', 'Fr Anthony Mourad', 'Mark Botros', 'Andrew Nada', 'Fr Anthony Morgan', 'Maryann Salib', 'Karin Zaki', 'Evram Nayrouz', 'Sherif Samaan', 'Fr Daniel Meleka', 'Peter Fawzy', 'Fr John Daher', 'Fr Geoff Harvey', 'Monica Doss', 'Fr Boules George', 'Sarah Abdelshaheed', 'Fr Youhanna Yanny', 'David Khalil', 'Fr David Mahrous', 'Mark Rafla', 'Albert Becky', 'HG Bishop Biemen', 'Fr Jonathan Ishak', 'Janet Lawandi', 'Fr John Boutros', 'Steph William', 'Kymo Elghitany', 'Sandra Mathoslah', 'Claire Ishak', 'Fr John Mikhail', 'Yvette Samir', 'Mira Ghaly ft. Andre Mina', 'Suzie Shenouda', 'Jonathan Rafla', 'Fady Basily', 'Bass Sowmi', 'Guest Speakers', 'Daniel El Gawly', 'John Poon', 'HG Bishop Thomas', 'Kerolos Rizkalla', 'Mina Ekdawi', 'Fr John Behr', 'Ann Michael', 'Mark Malek', 'HG Bishop Abraham', 'Fr James Mikhail', 'Fr Paul Fanous', 'HG Bishop Kyrillos', 'Fr Matthew Attia', 'Lysa Anis & Angela Girgis', 'Sam Farah', 'Mary Nicola', 'Fr Augustinos Nada', 'Chris Younan', 'Catherine Fanous', 'Magdy Rezk', 'Fr Mark Cherubim', 'Mario Malik', 'Andrew Messiha', 'Graham Barker', 'HG Bishop Agathon', 'Monica Gerges', 'HG Bishop Suriel', 'Matthew Dawoud', 'Lydia Gore-Jones', 'Marina Iskander', 'Fr Andrew Iskander', 'Luke A. Barnes', 'Christine Azer', 'Mina Abdelmalek', 'John Saad', 'Fr Gregory Bekhit', 'Aida Samir and Maria Andrawis', 'Tomas Moussa', 'Fr Reweis Antoun', 'Michael Kozman', 'Debbie Armanious', 'Fr Daoud Lamei', 'Mariam Kaldas', 'Joshua Williams', 'Christine Chaillot', 'HG Bishop David', 'John Girgis', 'Tamer Abdelshaheed', 'Fr Daniel', 'Moheb Khela', 'Daniel Girgis', 'Mina Saleeb', 'Vicky Maurice', 'HH Mor Ignatius Aphrem 2nd', 'John Messih', 'Marc Eskander', 'Rosemary Rizk', 'Ramez Mikhail', 'Emma Botros ft Marianne Botros', 'Ninette Basily', 'Fr Pishoy Wasfy', 'Maria Sawiris', 'Fadi Habib', 'Cassandra Mikhail', 'Evan Kardaras', 'Prof Mark Brown', 'Emma Botros', 'HG Bishop Angaelos', 'St George Choir', 'Fr Anthony Paul', 'Joseph Magdy', 'Emmanuel Gergis', 'Fr Michael Sorial', 'Mary Eskaroos', 'Monty Salama', 'Fady Kozman', 'Fr Doru Costache', 'Jacquie Atalla', 'Mina Botrous', 'Stuart A', 'Vivian Philips', 'Maestro Recording Studio', 'Fr Theodore Ghaly', 'Nirvana Salama', 'HG Bishop Gregory', 'Jen Tanios', 'Chrissy Maurice', 'Fr Sharobim', 'Fr Joseph Abraham', 'Tony Salib', 'Bishoy Tawadrous', 'John', 'Fr Lazarus Yassa', 'Fr Matthias Shehad', 'Fr Abraham Fam', 'Fr Theodore Labib', 'Eddie Botros', 'Michael Eskaros', 'Aziz Surial Atteya', 'Jacqui Gad', 'Mariah Melek', 'Antonio Sleiman', 'Fr Daniel Fanous', 'Fr George Nakhil', 'Margaret Tadros', 'HE Metropolitan Serapion', 'Eporanion Choir', 'Isaac Narouz']
f = open('only_speakers.json')
data = json.load(f)
images_json = json.load(open('subsplash_speaker_images.json'))
d = []
# for i in data:
#     for image in images_json['_embedded']['images']:
#         current_speaker = i['title'].replace('.', '')
#         if image.get('title') != None and image.get('width') != None and image.get('height') != None:
#             if image['width'] == image['height'] and (current_speaker.lower() in image['title'].lower() or i['title'].lower() in image['title'].lower()):
#                 d.append({'title': i['title'], 'id': i['id'], 'type': image['type'], 'downloadLink': image['_links']
#                               ['download']['href'], 'height': image['height'], 'width': image['width']})
#                 break
# # d = [*set(d)]
# for i in d:
#     print(i['title'])
# print(len(d))
for i in speakers:
    images_list = []
    for image in images_json['_embedded']['images']:
        current_speaker = i.replace('.', '')
        if image.get('title') != None and image.get('width') != None and image.get('height') != None:
            if image['width'] == image['height'] and (current_speaker.lower() in image['title'].lower() or i.lower() in image['title'].lower()):
                images_list.append({'type': 'square', 'downloadLink': image['_links']['download']['href'], 'height': image['height'], 'width': image['width'], 'id': image['id']})
                break
    d.append({'name': i, 'listId': None, 'listName': None, 'images': None if len(images_list) == 0 else images_list})

lists_json = json.load(open('subsplash_lists.json'))
count = 0
for i in d:
    for list in lists_json['_embedded']['lists']:
        if list['title'].lower().replace('.', '') == i['name'].lower().replace('.', ''):
            count += 1
            i['listId'] = list['id']
            i['listName'] = list['title']

            break
with open('newSpeakersToUpload.json', 'w') as f:
    json.dump(d, f, indent=2)
# f = open('only_speakers.json')
# data = json.load(f)

# speakers_objects = []

# with open('speakersToUpload.json', 'w') as speakers:
#     d = []
#     for i in data:

#         images = i['_embedded']['images']
#         image_dict = []
#         for image in images:
#             image_dict.append({'title': i['title'], 'id': i['id'], 'type': image['type'], 'downloadLink': image['_links']
#                               ['download']['href'], 'height': image['height'], 'width': image['width']})
#         d.append({'list_id': i['id'], 'name': i['title'], 'images': image_dict})

#     json.dump(d, f, indent=2)


# f.close()