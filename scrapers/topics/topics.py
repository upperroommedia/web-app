import json

f = open('topics.json')
data = json.load(f)

topics = ['Faith', 'Church', 'Prayer', 'Eternal Life', 'Relationship', 'Joy', 'Lent', 'Salvation', 'Holy Spirit', 'Repentance', 'Resurrection', 'Sacraments', 'Hope', 'Service', 'Unity', 'Peace', 'Purpose', 'Parable', 'St Mary', 'Healing', 'Trust', 'Humility', 'Fear', 'Miracle', 'Forgiveness', 'Grace', 'Liturgy', 'Temptation', 'Tribulation', 'Following Christ', 'Comfort', 'Sacrifice', 'Marriage', 'Wisdom', 'Obedience', 'Fasting', 'Mercy', 'Blessings', 'Evangelism', 'Pentecost', "God's Will", 'Doubt', 'Second Coming', 'Nativity', 'Desire For God', 'Confession', 'Loneliness', 'Creation', 'Identity', 'Spiritual Warfare', 'Purity',
          'Transformation', 'Judgement', 'Renewal', 'Discipleship', 'Covenant', 'Friendship', 'The Christian Life', 'Patience', 'Pride', 'Orthodoxy', 'Anger', "God's Promise", "God's Love", 'Fellowship', 'Trinity', 'Commitment', 'Mental Health', 'Jesus Christ', 'Love', 'Martyrdom', 'Anxiety', 'The Bible', 'Thankfulness', 'Sin', 'Gentleness', 'Social Media', 'Gospel', 'Suffering', 'Childhood', 'Politics', 'Lukewarmness', 'Gossip', 'Asceticism', 'Holiness', 'Holy Week', 'Homosexuality', 'Virtues', 'Kingdom of God', 'Christmas', 'Racism', 'Envy', 'Jesus', 'Discipline', 'Community', 'Death', 'Parables', 'Sovereignty of God', 'Apologetics', 'Humanity']

topics_objects = []

with open('topicsToAdd.json', 'w') as f:
    d = []
    for i in data:
        print(i['title'])
        images = None if i.get('_embedded') == None else i['_embedded']['images']
        image_dict = []
        if images != None:
            for image in images:
                image_dict.append({'title': i['title'], 'id': i['id'], 'type': image['type'], 'downloadLink': image['_links']
                                ['download']['href'], 'height': image['height'], 'width': image['width']})
        d.append({'listId': i['id'], 'name': i['title'], 'images': 'null' if images == None else image_dict})

    json.dump(d, f, indent=2)


f.close()
